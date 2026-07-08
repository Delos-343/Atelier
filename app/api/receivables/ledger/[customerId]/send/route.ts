import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getCustomerLedger, recordStatementEmail } from '@/server/receivables';
import { renderLedgerPdf, pdfFilename } from '@/server/pdf/documentPdf';
import { emailStatementSchema } from '@/schemas/documents';
import { isMailConfigured, sendMail } from '@/lib/mail/mailer';
import { logger } from '@/lib/logger';
import { enforceRateLimit } from '@/lib/security/enforce';

export const dynamic = 'force-dynamic';

/**
 * Email a customer their statement of account, with the running-account PDF for the
 * period attached. Order of operations mirrors the document email: send first, record
 * second, so a statement_emails row always means "the mail server accepted this". The
 * rare inverse — sent but the record failed — is answered with an explicit error and a
 * loud log rather than a silent success, since an unrecorded send is an audit gap.
 */
export async function POST(request: Request, { params }: { params: { customerId: string } }) {
  // Statement emailing hits an external SMTP relay — throttle per client.
  const limited = await enforceRateLimit(request, { name: 'statement-email', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = emailStatementSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  if (parsed.data.start > parsed.data.end) {
    return NextResponse.json({ error: 'The start date must not be after the end date.' }, { status: 400 });
  }

  if (!isMailConfigured()) {
    return NextResponse.json(
      {
        error:
          'Email is not configured. Set SMTP_HOST and MAIL_FROM (see .env.example) to enable sending statements.',
      },
      { status: 503 },
    );
  }

  const { to, subject, message, start, end } = parsed.data;
  const led = await getCustomerLedger(auth.supabase, params.customerId, start, end);
  if (!led.ok) return NextResponse.json({ error: led.error }, { status: led.status });
  const customer = led.data.customer;
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found.' }, { status: 404 });
  }

  let pdf: Uint8Array;
  try {
    pdf = await renderLedgerPdf({
      party: { code: customer.code, name: customer.name, email: customer.email, phone: customer.phone, address: customer.address },
      start: led.data.start,
      end: led.data.end,
      closingBalance: led.data.closingBalance,
      entries: led.data.entries,
    });
  } catch (e) {
    logger.error('statementEmail.render failed', {
      customerId: params.customerId,
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: 'Failed to render the statement PDF.' }, { status: 500 });
  }

  const sent = await sendMail({
    to,
    subject,
    text: message,
    attachments: [
      {
        filename: pdfFilename('Statement', customer.code),
        content: Buffer.from(pdf),
        contentType: 'application/pdf',
      },
    ],
  });
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 502 });

  const recorded = await recordStatementEmail(auth.supabase, {
    customerId: params.customerId,
    periodStart: start,
    periodEnd: end,
    recipient: to,
    subject,
  });
  if (!recorded.ok) {
    logger.error('statementEmail.sent_but_unrecorded', {
      customerId: params.customerId,
      recipient: to,
      recordError: recorded.error,
    });
    return NextResponse.json(
      { error: `The email was sent, but recording it failed (${recorded.error}) — check the server logs.` },
      { status: 500 },
    );
  }

  return NextResponse.json({ data: { id: recorded.data.id, recipient: to } });
}

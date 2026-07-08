import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getIssuedDocument, recordIssuedDocumentEmail } from '@/server/issuedDocuments';
import { renderIssuedPdf, issuedPdfPrefix, pdfFilename } from '@/server/pdf/documentPdf';
import { emailDocumentSchema } from '@/schemas/documents';
import { isMailConfigured, sendMail } from '@/lib/mail/mailer';
import { logger } from '@/lib/logger';
import { enforceRateLimit } from '@/lib/security/enforce';

export const dynamic = 'force-dynamic';

/**
 * Email an issued document to the customer, with the PDF rendered from its FROZEN
 * snapshot attached — the customer receives exactly the figures that were filed,
 * regardless of what the order looks like today. Order of operations is deliberate:
 * send first, record second, so a document_emails row always means "the mail server
 * accepted this". The rare inverse — sent but the record insert failed — is answered
 * with an explicit error and a loud log rather than a silent success, because an
 * unrecorded send is an audit gap the admin must know about.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  // Emailing hits an external SMTP relay, so cap it per client independent of auth.
  const limited = await enforceRateLimit(request, { name: 'doc-email', limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = emailDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  if (!isMailConfigured()) {
    return NextResponse.json(
      {
        error:
          'Email is not configured. Set SMTP_HOST and MAIL_FROM (see .env.example) to enable sending documents.',
      },
      { status: 503 },
    );
  }

  const doc = await getIssuedDocument(auth.supabase, params.id);
  if (!doc.ok) return NextResponse.json({ error: doc.error }, { status: doc.status });
  if (doc.data.voidedAt) {
    // A voided document must not reach a customer's inbox looking live. Blocked
    // HERE, before the send — not inside record_document_email(), whose one job is
    // recording sends that already happened.
    return NextResponse.json(
      { error: 'This document is voided and cannot be emailed.' },
      { status: 409 },
    );
  }

  let pdf: Uint8Array;
  try {
    pdf = await renderIssuedPdf(doc.data.kind, doc.data.snapshot);
  } catch (e) {
    logger.error('documentEmail.render failed', {
      id: params.id,
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: 'Failed to render the document PDF.' }, { status: 500 });
  }

  const { to, subject, message } = parsed.data;
  const sent = await sendMail({
    to,
    subject,
    text: message,
    attachments: [
      {
        filename: pdfFilename(issuedPdfPrefix(doc.data.kind), doc.data.documentNumber),
        content: Buffer.from(pdf),
        contentType: 'application/pdf',
      },
    ],
  });
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 502 });

  const recorded = await recordIssuedDocumentEmail(auth.supabase, {
    issuedDocumentId: params.id,
    recipient: to,
    subject,
    message,
  });
  if (!recorded.ok) {
    // The email left the building but the record insert failed — surface it, loudly.
    logger.error('documentEmail.sent_but_unrecorded', {
      id: params.id,
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

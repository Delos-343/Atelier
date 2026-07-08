import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getCustomerLedger } from '@/server/receivables';
import { renderLedgerPdf, pdfResponse } from '@/server/pdf/documentPdf';
import { isMailConfigured } from '@/lib/mail/mailer';

export const dynamic = 'force-dynamic';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A customer's running-account statement over a period. Admin-gated. Returns JSON, or a
 * sendable PDF with ?format=pdf. The balance-forward counterpart to the aged statement:
 * an opening balance, then every dated transaction with a carried balance.
 */
export async function GET(request: Request, { params }: { params: { customerId: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const start = url.searchParams.get('start') ?? '';
  const end = url.searchParams.get('end') ?? '';
  if (!YMD.test(start) || !YMD.test(end)) {
    return NextResponse.json({ error: 'Provide start and end dates as YYYY-MM-DD.' }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: 'The start date must not be after the end date.' }, { status: 400 });
  }

  const res = await getCustomerLedger(auth.supabase, params.customerId, start, end);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (url.searchParams.get('format') === 'pdf') {
    const l = res.data;
    if (!l.customer) return NextResponse.json({ error: 'Customer not found.' }, { status: 404 });
    const pdf = await renderLedgerPdf({
      party: {
        code: l.customer.code,
        name: l.customer.name,
        email: l.customer.email,
        phone: l.customer.phone,
        address: l.customer.address,
      },
      start: l.start,
      end: l.end,
      closingBalance: l.closingBalance,
      entries: l.entries,
    });
    return pdfResponse(pdf, 'Statement', l.customer.code);
  }
  return NextResponse.json({ data: { ...res.data, emailEnabled: isMailConfigured() } });
}

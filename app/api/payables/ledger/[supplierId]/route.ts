import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getSupplierLedger } from '@/server/payables';
import { renderLedgerPdf, pdfResponse } from '@/server/pdf/documentPdf';

export const dynamic = 'force-dynamic';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A supplier's running-account statement over a period. Admin-gated. Returns JSON, or a
 * printable PDF with ?format=pdf. The AP counterpart to the customer ledger: an opening
 * balance, then every dated bill and payment with a carried balance ending at what's owed.
 */
export async function GET(request: Request, { params }: { params: { supplierId: string } }) {
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

  const res = await getSupplierLedger(auth.supabase, params.supplierId, start, end);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (url.searchParams.get('format') === 'pdf') {
    const l = res.data;
    if (!l.supplier) return NextResponse.json({ error: 'Supplier not found.' }, { status: 404 });
    const pdf = await renderLedgerPdf({
      party: {
        code: l.supplier.code,
        name: l.supplier.name,
        email: l.supplier.email,
        phone: l.supplier.phone,
        address: l.supplier.address,
      },
      start: l.start,
      end: l.end,
      closingBalance: l.closingBalance,
      entries: l.entries,
    });
    return pdfResponse(pdf, 'Supplier statement', l.supplier.code);
  }
  return NextResponse.json({ data: res.data });
}

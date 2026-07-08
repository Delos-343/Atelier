import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getCustomerStatement } from '@/server/receivables';
import { renderStatementPdf, pdfResponse } from '@/server/pdf/documentPdf';

export const dynamic = 'force-dynamic';

/**
 * A customer's statement of account as of a date (default today). Admin-gated. Returns
 * JSON, or a sendable PDF with ?format=pdf. Everything comes from receivables_aging()
 * filtered to this customer — the same derivation as the aging report, so the statement
 * can't disagree with it.
 */
export async function GET(request: Request, { params }: { params: { customerId: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const asOf = url.searchParams.get('asOf') ?? undefined;
  const res = await getCustomerStatement(auth.supabase, params.customerId, asOf);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (url.searchParams.get('format') === 'pdf') {
    const s = res.data;
    if (!s.customer) return NextResponse.json({ error: 'Customer not found.' }, { status: 404 });
    const pdf = await renderStatementPdf({
      party: {
        code: s.customer.code,
        name: s.customer.name,
        email: s.customer.email,
        phone: s.customer.phone,
        address: s.customer.address,
      },
      asOf: s.asOf,
      invoices: s.invoices.map((i) => ({
        documentNumber: i.documentNumber,
        issuedAt: i.issuedAt,
        dueDate: i.dueDate,
        daysOverdue: i.daysOverdue,
        open: i.open,
      })),
      buckets: s.buckets,
      outstanding: s.outstanding,
    });
    return pdfResponse(pdf, 'Statement', s.customer.code);
  }
  return NextResponse.json({ data: res.data });
}

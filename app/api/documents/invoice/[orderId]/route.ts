import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getInvoiceDocument } from '@/server/documents';
import { renderInvoicePdf, pdfResponse } from '@/server/pdf/documentPdf';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { orderId: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await getInvoiceDocument(auth.supabase, params.orderId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (new URL(request.url).searchParams.get('format') === 'pdf') {
    return pdfResponse(await renderInvoicePdf(res.data), 'Invoice', res.data.number);
  }
  return NextResponse.json({ data: res.data });
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getCreditNoteDocument } from '@/server/documents';
import { renderCreditNotePdf, pdfResponse } from '@/server/pdf/documentPdf';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { creditNoteId: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await getCreditNoteDocument(auth.supabase, params.creditNoteId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (new URL(request.url).searchParams.get('format') === 'pdf') {
    return pdfResponse(await renderCreditNotePdf(res.data), 'CreditNote', res.data.number);
  }
  return NextResponse.json({ data: res.data });
}

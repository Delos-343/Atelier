import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getIssuedDocument } from '@/server/issuedDocuments';
import { renderIssuedPdf, issuedPdfPrefix, pdfResponse } from '@/server/pdf/documentPdf';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await getIssuedDocument(auth.supabase, params.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  if (new URL(request.url).searchParams.get('format') === 'pdf') {
    const pdf = await renderIssuedPdf(res.data.kind, res.data.snapshot, {
      watermark: res.data.voidedAt ? 'VOID' : undefined,
    });
    return pdfResponse(pdf, issuedPdfPrefix(res.data.kind), res.data.documentNumber);
  }
  return NextResponse.json({ data: res.data });
}

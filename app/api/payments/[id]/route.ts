import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { deleteInvoicePayment } from '@/server/issuedDocuments';

export const dynamic = 'force-dynamic';

/**
 * Delete a hand-keyed payment — the admin correction path for a mistaken entry.
 * Payments are operational records, not a double-entry ledger; a ledger slice
 * would replace this with reversing entries.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const result = await deleteInvoicePayment(auth.supabase, params.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { deleteCreditAllocation } from '@/server/issuedDocuments';

export const dynamic = 'force-dynamic';

/**
 * Remove a credit allocation ([id]) — the admin correction path. Reopens both the
 * invoice's open balance and the credit note's remaining credit (the derivations net
 * live off the remaining allocations, so nothing else has to be adjusted).
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const result = await deleteCreditAllocation(auth.supabase, params.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

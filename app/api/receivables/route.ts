import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listReceivables } from '@/server/receivables';

export const dynamic = 'force-dynamic';

/** The receivables register: every issued invoice with its collection state. */
export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const result = await listReceivables(auth.supabase);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

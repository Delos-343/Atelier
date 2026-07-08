import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getEmailHistory } from '@/server/emailHistory';

export const dynamic = 'force-dynamic';

/**
 * The unified send-history log — every recorded document and statement email, most recent
 * first. Admin-gated; the function is read-only over the two append-only trails.
 */
export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await getEmailHistory(auth.supabase);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

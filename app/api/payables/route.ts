import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listPayables } from '@/server/payables';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await listPayables(auth.supabase);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

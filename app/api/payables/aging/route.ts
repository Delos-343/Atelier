import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listPayablesAging } from '@/server/payables';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const asOf = new URL(request.url).searchParams.get('asOf') ?? undefined;
  const res = await listPayablesAging(auth.supabase, asOf);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { setSalesOrderStatus } from '@/server/sales';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const res = await setSalesOrderStatus(auth.supabase, params.id, body);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

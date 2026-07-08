import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { shipSalesOrder } from '@/server/sales';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await shipSalesOrder(auth.supabase, params.id);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

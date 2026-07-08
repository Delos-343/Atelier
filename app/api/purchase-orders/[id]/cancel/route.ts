import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { cancelPurchaseOrder } from '@/server/procurement';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await cancelPurchaseOrder(auth.supabase, params.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

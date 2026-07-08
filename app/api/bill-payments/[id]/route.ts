import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { deleteBillPayment } from '@/server/payables';

export const dynamic = 'force-dynamic';

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await deleteBillPayment(auth.supabase, params.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

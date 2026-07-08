import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { billPurchaseOrder } from '@/server/procurement';
import { billPurchaseOrderSchema } from '@/schemas/procurement';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = billPurchaseOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const res = await billPurchaseOrder(auth.supabase, params.id, {
    billNumber: parsed.data.billNumber,
    billDate: parsed.data.billDate,
    amount: parsed.data.amount ?? null,
    taxAmount: parsed.data.taxAmount ?? 0,
    dueDate: parsed.data.dueDate ?? null,
    description: parsed.data.description ?? null,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

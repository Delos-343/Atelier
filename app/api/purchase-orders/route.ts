import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listPurchaseOrders, createPurchaseOrder } from '@/server/procurement';
import { purchaseOrderCreateSchema } from '@/schemas/procurement';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await listPurchaseOrders(auth.supabase);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = purchaseOrderCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const res = await createPurchaseOrder(auth.supabase, parsed.data);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

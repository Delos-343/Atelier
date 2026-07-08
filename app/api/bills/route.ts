import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listBills, createBill } from '@/server/payables';
import { billCreateSchema } from '@/schemas/purchasing';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const supplierId = new URL(request.url).searchParams.get('supplierId') ?? undefined;
  const res = await listBills(auth.supabase, supplierId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = billCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const { supplierId, billNumber, billDate, amount, dueDate, description, taxAmount } = parsed.data;
  const res = await createBill(auth.supabase, {
    supplierId,
    billNumber,
    billDate,
    amount,
    dueDate: dueDate ?? null,
    description: description ?? null,
    taxAmount: taxAmount ?? 0,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listReceipts, applyCustomerReceipt } from '@/server/receipts';
import { receiptCreateSchema } from '@/schemas/receipts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const customerId = new URL(request.url).searchParams.get('customerId') ?? undefined;
  const res = await listReceipts(auth.supabase, customerId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = receiptCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const { customerId, receiptDate, amount, method, reference, allocations } = parsed.data;
  const res = await applyCustomerReceipt(auth.supabase, {
    customerId,
    receiptDate,
    amount,
    method: method ?? null,
    reference: reference ?? null,
    allocations,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

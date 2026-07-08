import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { recordBillPayment } from '@/server/payables';
import { recordPaymentSchema } from '@/schemas/payments';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = recordPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const { amount, paidDate, method, reference } = parsed.data;
  const res = await recordBillPayment(auth.supabase, {
    billId: params.id,
    amount,
    paidDate,
    method: method || null,
    reference: reference || null,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

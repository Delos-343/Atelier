import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { applyReceipt } from '@/server/receipts';
import { applyReceiptSchema } from '@/schemas/receipts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = applyReceiptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }
  const res = await applyReceipt(auth.supabase, params.id, parsed.data.allocations);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

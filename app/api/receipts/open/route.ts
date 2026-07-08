import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listCustomerOpenInvoices } from '@/server/receipts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const customerId = new URL(request.url).searchParams.get('customerId');
  if (!customerId) return NextResponse.json({ error: 'A customer is required.' }, { status: 400 });
  const res = await listCustomerOpenInvoices(auth.supabase, customerId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

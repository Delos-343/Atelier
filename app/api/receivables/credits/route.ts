import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listCustomerCredits } from '@/server/receivables';

export const dynamic = 'force-dynamic';

/**
 * A customer's credit notes that still carry usable credit — the picker behind
 * "Apply credit" on an open invoice. Admin-gated; the customer is passed as
 * ?customerId=… (the order page knows its own customer).
 */
export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const customerId = new URL(request.url).searchParams.get('customerId');
  if (!customerId) {
    return NextResponse.json({ error: 'A customerId is required.' }, { status: 400 });
  }

  const result = await listCustomerCredits(auth.supabase, customerId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

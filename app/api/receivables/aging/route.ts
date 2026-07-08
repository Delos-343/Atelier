import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listReceivablesAging } from '@/server/receivables';

export const dynamic = 'force-dynamic';

/**
 * Receivables aging: open invoices bucketed by age and grouped by customer, derived
 * in one place by receivables_aging() (which reuses invoice_receivables()). This
 * route authenticates and relays. Admin-only.
 */
export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const result = await listReceivablesAging(auth.supabase);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

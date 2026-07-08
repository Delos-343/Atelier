import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listPurchaseOrderExceptions } from '@/server/procurement';

export const dynamic = 'force-dynamic';

/**
 * The three-way match exceptions — purchase orders over- or under-billed against the goods
 * received — as a worklist. Admin-gated. Optional ?supplier= narrows to one supplier.
 */
export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const supplier = new URL(request.url).searchParams.get('supplier') ?? undefined;
  const res = await listPurchaseOrderExceptions(auth.supabase, supplier);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ data: res.data });
}

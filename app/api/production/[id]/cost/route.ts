import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { getProductionOrderCost } from '@/server/costing';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();

  // Access is governed by RLS on production_orders plus the authenticated-only grant
  // on production_order_cost(), consistent with the other production routes.
  const res = await getProductionOrderCost(supabase, params.id);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

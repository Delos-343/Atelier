import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { getProductionOrderHalal } from '@/server/compliance';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();

  // Read-only verdict, governed by RLS on production_orders plus the authenticated-only
  // grant on formula_version_halal_noncompliance(), consistent with the cost route.
  const res = await getProductionOrderHalal(supabase, params.id);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

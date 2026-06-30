import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { apiAuth } from '@/lib/auth/api-guard';
import { listSalesOrders, createSalesOrder } from '@/server/sales';

export const dynamic = 'force-dynamic';

// Reads are governed by RLS (any authenticated user); writes are admin-gated.
export async function GET() {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();
  const res = await listSalesOrders(supabase);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const res = await createSalesOrder(auth.supabase, body);
  return res.ok
    ? NextResponse.json({ data: res.data }, { status: 201 })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

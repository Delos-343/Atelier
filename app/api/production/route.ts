import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { createProductionOrder } from '@/server/production';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();
  const { data, error } = await supabase
    .from('production_orders')
    .select('id, code, status, planned_quantity, unit, created_at, completed_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });

  const result = await createProductionOrder(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result.data, { status: 201 });
}

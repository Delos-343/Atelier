import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();
  const id = params.id;

  try {
    const [lotRes, movRes, ancRes, descRes] = await Promise.all([
      supabase
        .from('inventory_lots')
        .select('id, lot_code, item_type, status, quantity_on_hand, unit, expiry_date')
        .eq('id', id)
        .single(),
      supabase
        .from('stock_movements')
        .select('id, movement_type, quantity, unit, reference_type, created_at')
        .eq('lot_id', id)
        .order('created_at', { ascending: true }),
      supabase.rpc('trace_lot_ancestors', { p_lot_id: id }),
      supabase.rpc('trace_lot_descendants', { p_lot_id: id }),
    ]);

    if (lotRes.error || !lotRes.data) {
      return NextResponse.json({ error: lotRes.error?.message ?? 'lot not found' }, { status: 404 });
    }

    return NextResponse.json({
      data: {
        lot: lotRes.data,
        movements: movRes.data ?? [],
        ancestors: ancRes.data ?? [],
        descendants: descRes.data ?? [],
      },
    });
  } catch (err) {
    logger.error('GET /api/lots/[id] failed', { id, err: String(err) });
    return NextResponse.json({ error: 'Could not reach the database.' }, { status: 502 });
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { logger } from '@/lib/logger';
import type { Database } from '@/types/database';

export const dynamic = 'force-dynamic';

type LotStatus = Database['public']['Enums']['lot_status'];
const STATUSES: readonly LotStatus[] = ['available', 'quarantine', 'expired', 'consumed', 'rejected'];
const isLotStatus = (s: string): s is LotStatus => (STATUSES as readonly string[]).includes(s);

export async function GET(request: Request) {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();
  try {
    const status = new URL(request.url).searchParams.get('status');

    let query = supabase
      .from('inventory_lots')
      .select('id, lot_code, item_type, status, quantity_on_hand, unit, expiry_date')
      .order('expiry_date', { nullsFirst: false });

    if (status && isLotStatus(status)) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (err) {
    logger.error('GET /api/inventory failed', { err: String(err) });
    return NextResponse.json({ error: 'Could not reach the database.' }, { status: 502 });
  }
}

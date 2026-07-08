import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseNotConfigured } from '@/lib/supabase/guard';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  if (!supabase) return supabaseNotConfigured();
  try {
    const { data, error } = await supabase
      .from('formulas')
      .select('id, code, name, formula_versions(id, version_no, basis, is_locked)')
      .order('code');
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data });
  } catch (err) {
    logger.error('GET /api/formulas failed', { err: String(err) });
    return NextResponse.json({ error: 'Could not reach the database.' }, { status: 502 });
  }
}

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import type { DbClient } from '@/lib/supabase/types';
import type { AppRole } from './session';

type ApiAuthResult =
  | { ok: true; supabase: DbClient; role: AppRole }
  | { ok: false; response: NextResponse };

const fail = (status: number, error: string): ApiAuthResult => ({
  ok: false,
  response: NextResponse.json({ error }, { status }),
});

/**
 * Authorization gate for API route handlers. Unlike the page guards (which
 * redirect), this returns a JSON error Response so fetch callers get a clean
 * status. Admin is a superset of every clearance. RLS remains the backstop —
 * this is the fast, explicit first line.
 */
export async function apiAuth(required: AppRole): Promise<ApiAuthResult> {
  if (!isSupabaseConfigured()) return fail(503, 'Supabase is not configured.');

  const supabase = createClient();
  if (!supabase) return fail(503, 'Supabase is not configured.');

  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    return fail(401, 'Authentication required.');
  }
  if (!userId) return fail(401, 'Authentication required.');

  const { data: roleData, error } = await supabase.rpc('current_app_role');
  const role = (error ? 'viewer' : ((roleData as AppRole) ?? 'viewer')) as AppRole;

  if (role !== required && role !== 'admin') {
    return fail(403, `This action requires ${required} clearance.`);
  }

  return { ok: true, supabase, role };
}

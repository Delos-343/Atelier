import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';

export type AppRole = 'admin' | 'production' | 'qc' | 'viewer';

export interface UserAndRole {
  user: User | null;
  role: AppRole | null;
}

/**
 * Resolve the current request's user and application role, deduped per request.
 * `current_app_role()` is SECURITY DEFINER and granted to authenticated, so a
 * signed-in user with no app_users row resolves to 'viewer' (read-only).
 * Returns nulls when Supabase isn't configured (UI-preview mode).
 */
export const getUserAndRole = cache(async (): Promise<UserAndRole> => {
  const supabase = createClient();
  if (!supabase) return { user: null, role: null };

  try {
    const { data } = await supabase.auth.getUser();
    const user = data.user ?? null;
    if (!user) return { user: null, role: null };

    const { data: role, error } = await supabase.rpc('current_app_role');
    return { user, role: error ? 'viewer' : ((role as AppRole) ?? 'viewer') };
  } catch {
    // Auth endpoint unreachable — treat as signed out (degrade, don't 500).
    return { user: null, role: null };
  }
});

/**
 * Gate a server route/layout behind authentication. In preview mode (no backend)
 * it allows render so the UI can be explored; otherwise it redirects signed-out
 * users to /login. Use at the top of protected layouts.
 */
export async function requireAuth(): Promise<User | null> {
  if (!isSupabaseConfigured()) return null; // preview: open
  const { user } = await getUserAndRole();
  if (!user) redirect('/login');
  return user;
}

/**
 * Gate behind a specific clearance. Admin is a superset (passes every gate).
 * Preview mode is open. Insufficient clearance is redirected to /app.
 */
export async function requireRole(required: AppRole): Promise<UserAndRole> {
  if (!isSupabaseConfigured()) return { user: null, role: 'admin' }; // preview: open
  const { user, role } = await getUserAndRole();
  if (!user) redirect('/login');
  if (role !== required && role !== 'admin') redirect('/app');
  return { user, role };
}

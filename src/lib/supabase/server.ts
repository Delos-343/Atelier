import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { supabaseEnv } from './env';
import type { Database } from '@/types/database';

/**
 * Server-side Supabase client bound to the request's cookies.
 * Returns null when Supabase isn't configured, so callers can report a clean
 * "not configured" response instead of throwing. Use inside Server Components,
 * Route Handlers, and Server Actions.
 */
export function createClient(): SupabaseClient<Database> | null {
  const env = supabaseEnv();
  if (!env) return null;

  const cookieStore = cookies();

  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Session refresh is handled by middleware, so this is safe to ignore.
        }
      },
    },
  });
}

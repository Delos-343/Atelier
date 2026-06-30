import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseEnv } from './env';
import type { Database } from '@/types/database';

/** Browser-side Supabase client for Client Components. Null when unconfigured. */
export function createClient(): SupabaseClient<Database> | null {
  const env = supabaseEnv();
  if (!env) return null;
  return createBrowserClient<Database>(env.url, env.anonKey);
}

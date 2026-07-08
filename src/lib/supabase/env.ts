/**
 * Reads the Supabase environment. Returns null when the project URL or client key
 * is missing, so the app can degrade gracefully (render the UI, skip auth, and
 * report "not configured" on data calls) instead of throwing at client creation.
 */
export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

export function supabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Accept both the legacy "anon key" name and Supabase's newer "publishable key" name.
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export const isSupabaseConfigured = (): boolean => supabaseEnv() !== null;

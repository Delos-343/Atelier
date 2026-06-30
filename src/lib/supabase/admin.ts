import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Service-role Supabase client — FULL DATABASE ACCESS, bypasses Row Level Security.
 *
 * This is the most privileged credential in the app. The rules around it:
 *
 *  - **Server-only.** Never import this into a client component. The key is read
 *    from `SUPABASE_SERVICE_ROLE_KEY` (note: no `NEXT_PUBLIC_` prefix), so Next.js
 *    never inlines it into the browser bundle. The `window` guard below hard-fails
 *    if this somehow executes client-side, rather than silently shipping the key.
 *
 *  - **Second line, never first.** Construct it per request, *inside* a route
 *    handler that has already verified the caller is an admin via `apiAuth('admin')`.
 *    It exists to perform the few operations RLS-bound SQL genuinely cannot:
 *    creating and deleting login accounts through the auth Admin API. Everything
 *    else goes through the cookie-bound client + RLS.
 *
 * Returns `null` when the service-role key (or project URL) is absent, so account
 * management degrades to a clean "not configured" response instead of throwing —
 * mirroring how the rest of the app handles a missing Supabase config.
 */
export function createAdminClient(): SupabaseClient<Database> | null {
  if (typeof window !== 'undefined') {
    throw new Error('createAdminClient must never be called in the browser.');
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  return createClient<Database>(url, serviceKey, {
    // No session to persist or refresh on the server — this client authenticates
    // solely with the service-role key.
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Whether login-account create/delete is available (service-role key configured). */
export function isAccountManagementConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

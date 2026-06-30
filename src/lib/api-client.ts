/**
 * Shared client-side fetch helper for the admin/console screens.
 *
 * Every API route in this app answers with a JSON envelope: `{ data }` on
 * success and `{ error }` on failure, with the HTTP status carrying the
 * category (400/401/403/404/409/422/5xx). `api()` unwraps that envelope —
 * returning `data` on a 2xx and throwing an `Error` carrying the server's
 * message otherwise — so callers can `try/catch` and surface `errMsg(e)`
 * without re-implementing the contract in every component.
 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status}).`);
  return json.data as T;
}

/** Narrow an unknown thrown value to a human-readable message. */
export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : 'Something went wrong.';

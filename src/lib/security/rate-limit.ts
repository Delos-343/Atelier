import { upstashEnv } from './config';
import { logger } from '@/lib/logger';

/**
 * A fixed-window rate limiter with two interchangeable backends:
 *
 *   • In-memory (default) — a module-level Map of counters, edge-runtime safe.
 *     Zero configuration, but per-instance: counters aren't shared across
 *     serverless lambdas and reset on redeploy. Right for the prototype / a
 *     single instance / preview mode.
 *
 *   • Upstash Redis (opt-in) — when UPSTASH_REDIS_REST_URL/TOKEN are set, the
 *     count is kept in Redis via its REST API (INCR + PEXPIRE in one pipeline),
 *     so the window is durable and shared across every instance. This is the
 *     production path.
 *
 * The choice is made per call from the environment, so wiring a route to
 * `rateLimit()` today automatically upgrades to durable limiting the moment the
 * Upstash vars appear — no code change. On any Upstash transport error we
 * FAIL OPEN (allow the request) and log: a limiter outage must never take down
 * the app, and the other layers (CAPTCHA, auth, RLS) remain in force.
 */

export interface RateLimitOptions {
  /** Logical bucket, e.g. 'login', 'api', 'email'. Namespaces the key. */
  name: string;
  /** Unique caller within the bucket, e.g. an IP or user id. */
  identifier: string;
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  /** False when the caller has exceeded the limit for this window. */
  ok: boolean;
  /** The configured ceiling (echoed for X-RateLimit-Limit). */
  limit: number;
  /** Requests still allowed in the current window (never negative). */
  remaining: number;
  /** Unix-ms timestamp when the current window resets. */
  reset: number;
  /** Seconds until reset — for a Retry-After header (only meaningful when !ok). */
  retryAfter: number;
}

// ─── In-memory backend ──────────────────────────────────────────────────────
// Kept at module scope so it survives across requests within one instance. Each
// entry is a fixed window: a count and the ms timestamp at which it resets.
interface Window {
  count: number;
  reset: number;
}
const store = new Map<string, Window>();

// Opportunistic sweep so the Map can't grow without bound under many distinct
// keys (e.g. a spray of IPs). Cheap: only runs when the store gets large.
function sweep(now: number): void {
  if (store.size < 10_000) return;
  for (const [k, w] of store) {
    if (w.reset <= now) store.delete(k);
  }
}

function inMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = store.get(key);
  if (!existing || existing.reset <= now) {
    const reset = now + windowMs;
    store.set(key, { count: 1, reset });
    return { ok: true, limit, remaining: limit - 1, reset, retryAfter: 0 };
  }
  existing.count += 1;
  const remaining = Math.max(0, limit - existing.count);
  const ok = existing.count <= limit;
  return {
    ok,
    limit,
    remaining,
    reset: existing.reset,
    retryAfter: ok ? 0 : Math.ceil((existing.reset - now) / 1000),
  };
}

// ─── Upstash (Redis REST) backend ───────────────────────────────────────────
// One atomic-enough sequence per call: INCR the key, and on the FIRST hit set a
// PEXPIRE equal to the window so the key self-heals. We read the TTL back to
// report an accurate reset. Uses the pipeline endpoint to do it in one round
// trip. Any non-2xx or network error throws, and the caller fails open.
async function upstash(
  key: string,
  limit: number,
  windowMs: number,
  env: { url: string; token: string },
): Promise<RateLimitResult> {
  const now = Date.now();
  const res = await fetch(`${env.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
    },
    // INCR first; if it's now 1 the key is new, so arm the expiry. We always ask
    // for the PTTL so we can compute an accurate reset regardless.
    body: JSON.stringify([
      ['INCR', key],
      ['PEXPIRE', key, String(windowMs), 'NX'],
      ['PTTL', key],
    ]),
    // Never let a slow limiter stall a request for long.
    signal: AbortSignal.timeout(1000),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const parts = (await res.json()) as Array<{ result?: number; error?: string }>;
  const count = Number(parts[0]?.result ?? 0);
  const pttl = Number(parts[2]?.result ?? windowMs);
  const reset = now + (pttl > 0 ? pttl : windowMs);
  const remaining = Math.max(0, limit - count);
  const ok = count <= limit;
  return {
    ok,
    limit,
    remaining,
    reset,
    retryAfter: ok ? 0 : Math.ceil((reset - now) / 1000),
  };
}

/**
 * Consume one unit from a caller's window and report whether it's allowed.
 * Picks the Upstash backend when configured, else in-memory; on an Upstash
 * failure it falls back to in-memory for THIS call (still better than nothing)
 * and logs, so a Redis blip degrades to per-instance limiting rather than none.
 */
export async function rateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const key = `rl:${opts.name}:${opts.identifier}`;
  const env = upstashEnv();
  if (!env) return inMemory(key, opts.limit, opts.windowMs);
  try {
    return await upstash(key, opts.limit, opts.windowMs, env);
  } catch (e) {
    logger.warn('rateLimit.upstash_failed_fallback_memory', {
      name: opts.name,
      message: e instanceof Error ? e.message : String(e),
    });
    return inMemory(key, opts.limit, opts.windowMs);
  }
}

/** Standard rate-limit headers for a response (RateLimit + Retry-After on 429). */
export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(Math.ceil(r.reset / 1000)),
  };
  if (!r.ok) headers['Retry-After'] = String(r.retryAfter);
  return headers;
}

/** Test-only: clear the in-memory store between cases. */
export function __resetRateLimitStore(): void {
  store.clear();
}

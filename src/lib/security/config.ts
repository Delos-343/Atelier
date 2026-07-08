/**
 * Central reader for the security layer's environment. Every knob here is
 * OPTIONAL: with nothing set, the app runs exactly as before — in-memory rate
 * limiting (per-instance, best-effort), no CAPTCHA, and the always-on security
 * headers / request filter that need no configuration. Set the vars to upgrade
 * each layer to production strength. This mirrors the project's house style:
 * features stay dormant until their keys are present, and degrade gracefully.
 */

export interface UpstashEnv {
  url: string;
  token: string;
}

/**
 * Upstash Redis (REST) credentials for a durable, cross-instance rate-limit
 * store. Returns null when unset, in which case the limiter falls back to an
 * in-memory window that is fine for a single instance / preview but resets on
 * redeploy and isn't shared across serverless lambdas.
 */
export function upstashEnv(): UpstashEnv | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export const isUpstashConfigured = (): boolean => upstashEnv() !== null;

/**
 * Cloudflare Turnstile site key (public — safe in the browser). The matching
 * SECRET key is configured in the Supabase dashboard (Auth -> Settings -> Enable
 * CAPTCHA protection), because Supabase itself verifies the token server-side on
 * sign-in. So this app only needs the site key to render the widget; when it's
 * unset, the login form drops the challenge and behaves as it did before.
 */
export function turnstileSiteKey(): string | null {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
}

export const isTurnstileConfigured = (): boolean => turnstileSiteKey() !== null;

/**
 * Master off-switch for rate limiting. Defaults ON. Set SECURITY_RATE_LIMIT=off
 * (or false/0) to disable the middleware/route throttles entirely — useful for
 * load tests or a trusted internal deployment sitting behind its own gateway.
 */
export function isRateLimitEnabled(): boolean {
  const v = (process.env.SECURITY_RATE_LIMIT ?? '').toLowerCase();
  return v !== 'off' && v !== 'false' && v !== '0';
}

/**
 * Master off-switch for the app-layer request filter (the "WAF-lite"). Defaults
 * ON. Set SECURITY_WAF=off to pass requests through unfiltered — appropriate
 * when a real WAF (Cloudflare, Vercel, AWS) already fronts the app and you'd
 * rather not double-filter.
 */
export function isWafEnabled(): boolean {
  const v = (process.env.SECURITY_WAF ?? '').toLowerCase();
  return v !== 'off' && v !== 'false' && v !== '0';
}

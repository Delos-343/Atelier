import { supabaseEnv } from '@/lib/supabase/env';

/**
 * The app-layer response-hardening headers — the part of a "WAF" that lives in
 * the application rather than the network edge. A real WAF (Cloudflare / Vercel
 * / AWS) is still recommended in front (see the README), but these ship with the
 * app so protection exists even on a bare deployment, and they can't be
 * misconfigured out of existence by an ops oversight.
 *
 * Highlights:
 *   • Content-Security-Policy — nonce-based in PRODUCTION: inline scripts must
 *     carry the per-request nonce (Next.js propagates it to its own bundles, and
 *     our one inline theme script opts in via the same nonce), so an injected
 *     <script> with no nonce won't execute. In DEVELOPMENT the policy is relaxed
 *     to allow 'unsafe-eval' / 'unsafe-inline' and the HMR websocket, because the
 *     Next dev server (React Fast Refresh / webpack HMR) evaluates code with
 *     eval() — a strict nonce+strict-dynamic policy would block the dev bundle
 *     and break all client interactivity. Turnstile's challenge frame/script are
 *     allowed in both modes; connect-src is opened to the configured Supabase
 *     origin (https + wss for realtime/auth).
 *   • HSTS — force HTTPS for a year including subdomains (only meaningful over
 *     TLS; skipped on plain-http local dev).
 *   • X-Frame-Options / frame-ancestors 'none' — clickjacking off.
 *   • X-Content-Type-Options nosniff, Referrer-Policy, a lean Permissions-Policy.
 */

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

function isDevEnv(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function connectSrc(dev: boolean): string {
  const parts = ["'self'"];
  // Dev: the Next HMR client opens a websocket back to the origin; some browsers
  // don't treat ws:// as covered by 'self', so allow it explicitly.
  if (dev) parts.push('ws:', 'wss:');
  const env = supabaseEnv();
  if (env) {
    // Supabase REST/Auth over https and realtime over wss.
    parts.push(env.url);
    try {
      const host = new URL(env.url).host;
      parts.push(`wss://${host}`);
    } catch {
      /* malformed URL — the https origin alone still covers REST/Auth */
    }
  }
  return parts.join(' ');
}

/**
 * Build the Content-Security-Policy string for a given per-request nonce.
 * `opts.dev` forces the relaxed development policy; when omitted it is derived
 * from NODE_ENV (anything other than "production" is treated as development).
 */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const dev = opts.dev ?? isDevEnv();

  // PRODUCTION: strict, nonce-based. 'strict-dynamic' lets nonce'd scripts load
  // their own dependencies (including the dynamically-injected Turnstile script)
  // while rejecting un-nonce'd inline injection.
  // DEVELOPMENT: Next's HMR/Fast-Refresh needs eval() and inline bootstrap, so a
  // strict policy would break hydration. Relax it — dev is not an exposed surface.
  const scriptSrc = dev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${TURNSTILE_ORIGIN}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: ${TURNSTILE_ORIGIN}`;

  const directives = [
    `default-src 'self'`,
    scriptSrc,
    // Tailwind ships static classes, but Next injects a little inline style for
    // streaming/hydration, so style needs 'unsafe-inline'. Styles can't exfiltrate
    // or execute, so this is low-risk.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc(dev)}`,
    // Turnstile renders its challenge in an iframe from this origin.
    `frame-src ${TURNSTILE_ORIGIN}`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  // Only force TLS upgrades in production; on plain-http localhost this would
  // rewrite dev asset requests to https and break them.
  if (!dev) directives.push(`upgrade-insecure-requests`);

  return directives.join('; ');
}

export interface SecurityHeaderOptions {
  nonce: string;
  /** Emit HSTS. Skip on plain-http local dev so nothing gets pinned to https. */
  hsts?: boolean;
  /** Force the dev/prod CSP variant; defaults to NODE_ENV-based detection. */
  dev?: boolean;
}

/** The full set of security headers as name/value pairs. */
export function securityHeaders({ nonce, hsts = true, dev }: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': buildCsp(nonce, dev === undefined ? {} : { dev }),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    'X-DNS-Prefetch-Control': 'off',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (hsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
  }
  return headers;
}

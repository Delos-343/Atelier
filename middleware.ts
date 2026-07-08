import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { inspectRequest } from '@/lib/security/waf';
import { rateLimit, rateLimitHeaders } from '@/lib/security/rate-limit';
import { securityHeaders } from '@/lib/security/headers';
import { clientIp } from '@/lib/security/request';
import { isWafEnabled, isRateLimitEnabled } from '@/lib/security/config';
import { logger } from '@/lib/logger';

/**
 * The request security pipeline, run before the Supabase session refresh:
 *
 *   1. WAF filter — shed obvious attack traffic (traversal, null bytes, XSS
 *      payloads, secret-file probes) with a 403.
 *   2. Rate limit — a broad per-IP throttle on /api/**, and a tighter one on the
 *      auth pages, to blunt scripted abuse and credential stuffing. Over-limit
 *      gets a 429 with Retry-After.
 *   3. Session + routing — the existing Supabase auth/clearance gate, now with a
 *      per-request CSP nonce threaded onto the request so inline scripts (ours
 *      and Next's) are allow-listed while injected ones are not.
 *   4. Security headers — CSP/HSTS/frame options/etc. stamped on the response.
 *
 * Each layer is independently switchable via env (SECURITY_WAF, SECURITY_RATE_LIMIT)
 * and every one degrades safely: a limiter outage fails open, the WAF only ever
 * blocks unambiguous shapes, and with nothing configured the app behaves exactly
 * as it did before this layer existed.
 */

// Per-IP request budgets. Generous enough to never touch real interactive use;
// low enough to matter to a script.
const API_LIMIT = { limit: 120, windowMs: 60_000 };
const AUTH_PAGE_LIMIT = { limit: 30, windowMs: 60_000 };

const AUTH_PAGES = ['/login', '/accept-invite'];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const isHttps =
    request.nextUrl.protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https';

  // ── 1. WAF filter ─────────────────────────────────────────────────────────
  if (isWafEnabled()) {
    const verdict = inspectRequest(pathname, search);
    if (verdict.blocked) {
      logger.warn('waf.blocked', {
        ip: clientIp(request.headers),
        path: pathname,
        reason: verdict.reason,
        rule: verdict.rule,
      });
      return new NextResponse('Forbidden', { status: 403 });
    }
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  if (isRateLimitEnabled()) {
    const ip = clientIp(request.headers);
    const bucket =
      pathname.startsWith('/api/')
        ? { name: 'api', ...API_LIMIT }
        : AUTH_PAGES.some((p) => pathname === p)
          ? { name: 'auth-page', ...AUTH_PAGE_LIMIT }
          : null;
    if (bucket) {
      const result = await rateLimit({ name: bucket.name, identifier: ip, limit: bucket.limit, windowMs: bucket.windowMs });
      if (!result.ok) {
        logger.warn('rateLimit.blocked', { bucket: bucket.name, ip, path: pathname, retryAfter: result.retryAfter });
        const body = pathname.startsWith('/api/')
          ? JSON.stringify({ error: `Too many requests. Try again in ${result.retryAfter}s.` })
          : 'Too many requests';
        return new NextResponse(body, {
          status: 429,
          headers: {
            ...rateLimitHeaders(result),
            'Content-Type': pathname.startsWith('/api/') ? 'application/json' : 'text/plain',
          },
        });
      }
    }
  }

  // ── 3. CSP nonce + session refresh ────────────────────────────────────────
  const nonce = btoa(crypto.randomUUID());
  const headers = securityHeaders({ nonce, hsts: isHttps });

  // Thread the nonce (and CSP) onto the REQUEST so Next.js stamps its inline
  // scripts with it and our layout can read x-nonce.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']!);

  const response = await updateSession(request, requestHeaders);

  // ── 4. Response security headers ──────────────────────────────────────────
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // run on everything except static assets and the service worker / manifest / icons
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/).*)'],
};

import { NextResponse } from 'next/server';
import { rateLimit, rateLimitHeaders, type RateLimitOptions } from './rate-limit';
import { isRateLimitEnabled } from './config';
import { clientIp } from './request';
import { logger } from '@/lib/logger';

/**
 * Route-handler rate-limit gate. Returns a ready-to-send 429 Response when the
 * caller is over the limit (with RateLimit-* and Retry-After headers), or null
 * to proceed. Meant to sit at the very top of a sensitive handler — the tighter
 * companion to the broad middleware throttle:
 *
 *   const limited = await enforceRateLimit(request, { name: 'email', limit: 5, windowMs: 60_000 });
 *   if (limited) return limited;
 *
 * The identifier defaults to the client IP; pass one (e.g. a user id) to scope
 * the window to an authenticated caller instead. Honors the SECURITY_RATE_LIMIT
 * master switch, so disabling it turns these off alongside the middleware ones.
 */
export async function enforceRateLimit(
  request: Request,
  opts: { name: string; limit: number; windowMs: number; identifier?: string },
): Promise<NextResponse | null> {
  if (!isRateLimitEnabled()) return null;

  const identifier = opts.identifier ?? clientIp(request.headers);
  const config: RateLimitOptions = {
    name: opts.name,
    identifier,
    limit: opts.limit,
    windowMs: opts.windowMs,
  };
  const result = await rateLimit(config);
  if (result.ok) return null;

  logger.warn('rateLimit.blocked', {
    name: opts.name,
    identifier,
    retryAfter: result.retryAfter,
  });
  return NextResponse.json(
    { error: `Too many requests. Try again in ${result.retryAfter}s.` },
    { status: 429, headers: rateLimitHeaders(result) },
  );
}

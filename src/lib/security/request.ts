/**
 * Best-effort client-IP extraction, ordered by trust. Behind a proxy/CDN
 * (Vercel, Cloudflare) the socket address is the edge, so the real client rides
 * in a forwarded header. We read the platform-specific ones first, then the
 * standards-ish x-forwarded-for (taking its FIRST hop — the original client),
 * and finally fall back to a constant so a missing IP buckets everyone into one
 * shared window rather than throwing. This is a rate-limit key, not an identity:
 * it never needs to be perfect, only stable and hard to trivially rotate.
 */
export function clientIp(headers: Headers): string {
  const vercel = headers.get('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0]!.trim();

  const real = headers.get('x-real-ip');
  if (real) return real.trim();

  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();

  return 'unknown';
}

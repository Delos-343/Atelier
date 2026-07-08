import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rateLimit, rateLimitHeaders, __resetRateLimitStore } from '../rate-limit';

// No UPSTASH_* env in the test process, so these exercise the in-memory backend.
describe('rateLimit (in-memory backend)', () => {
  beforeEach(() => __resetRateLimitStore());

  it('permits up to the limit, then blocks with a Retry-After', async () => {
    const opts = { name: 't', identifier: 'ip1', limit: 3, windowMs: 1000 };
    const r1 = await rateLimit(opts);
    expect(r1).toMatchObject({ ok: true, limit: 3, remaining: 2 });
    await rateLimit(opts);
    const r3 = await rateLimit(opts);
    expect(r3).toMatchObject({ ok: true, remaining: 0 });
    const r4 = await rateLimit(opts);
    expect(r4.ok).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfter).toBeGreaterThan(0);
  });

  it('keys windows independently per identifier', async () => {
    const base = { name: 't', limit: 1, windowMs: 1000 };
    expect((await rateLimit({ ...base, identifier: 'a' })).ok).toBe(true);
    expect((await rateLimit({ ...base, identifier: 'a' })).ok).toBe(false);
    // A different caller is unaffected.
    expect((await rateLimit({ ...base, identifier: 'b' })).ok).toBe(true);
  });

  it('keys windows independently per bucket name', async () => {
    const base = { identifier: 'ip', limit: 1, windowMs: 1000 };
    expect((await rateLimit({ ...base, name: 'login' })).ok).toBe(true);
    expect((await rateLimit({ ...base, name: 'login' })).ok).toBe(false);
    expect((await rateLimit({ ...base, name: 'email' })).ok).toBe(true);
  });

  it('resets after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const opts = { name: 't', identifier: 'ip', limit: 1, windowMs: 1000 };
      expect((await rateLimit(opts)).ok).toBe(true);
      expect((await rateLimit(opts)).ok).toBe(false);
      vi.advanceTimersByTime(1001);
      expect((await rateLimit(opts)).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimitHeaders', () => {
  it('emits RateLimit headers, adding Retry-After only when blocked', () => {
    const ok = rateLimitHeaders({ ok: true, limit: 5, remaining: 4, reset: 1_000_000, retryAfter: 0 });
    expect(ok['X-RateLimit-Limit']).toBe('5');
    expect(ok['X-RateLimit-Remaining']).toBe('4');
    expect(ok['Retry-After']).toBeUndefined();

    const blocked = rateLimitHeaders({ ok: false, limit: 5, remaining: 0, reset: 1_000_000, retryAfter: 30 });
    expect(blocked['Retry-After']).toBe('30');
  });
});

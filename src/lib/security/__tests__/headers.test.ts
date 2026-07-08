import { describe, it, expect } from 'vitest';
import { buildCsp, securityHeaders } from '../headers';

describe('buildCsp — production (strict)', () => {
  const csp = buildCsp('abc123', { dev: false });

  it('binds the per-request nonce into script-src and uses strict-dynamic', () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('allows the Turnstile challenge origin in script and frame sources', () => {
    expect(csp).toContain('https://challenges.cloudflare.com');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
  });

  it('locks down framing and object embedding and upgrades insecure requests', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

describe('buildCsp — development (relaxed for HMR)', () => {
  const csp = buildCsp('abc123', { dev: true });

  it("allows 'unsafe-eval'/'unsafe-inline' so Next dev HMR (eval) and hydration work", () => {
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).not.toContain('strict-dynamic');
  });

  it('permits the HMR websocket via connect-src', () => {
    expect(csp).toMatch(/connect-src[^;]*\bws:/);
  });

  it('does not force TLS upgrades on plain-http localhost', () => {
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('still allows the Turnstile origin', () => {
    expect(csp).toContain('https://challenges.cloudflare.com');
  });
});

describe('securityHeaders', () => {
  it('includes the core hardening headers', () => {
    const h = securityHeaders({ nonce: 'n', dev: false });
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('emits HSTS by default and omits it when disabled (plain-http dev)', () => {
    expect(securityHeaders({ nonce: 'n', dev: false })['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(securityHeaders({ nonce: 'n', hsts: false, dev: false })['Strict-Transport-Security']).toBeUndefined();
  });
});

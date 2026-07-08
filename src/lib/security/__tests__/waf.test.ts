import { describe, it, expect } from 'vitest';
import { inspectRequest } from '../waf';

describe('inspectRequest (WAF-lite)', () => {
  it('allows ordinary ERP traffic (ids, dates, query params)', () => {
    expect(inspectRequest('/app/sales/9f1c-uuid', '').blocked).toBe(false);
    expect(inspectRequest('/api/receivables/aging', '?asOf=2026-07-08').blocked).toBe(false);
    expect(inspectRequest('/admin/formulas/123', '?tab=versions&sort=name').blocked).toBe(false);
    expect(inspectRequest('/', '').blocked).toBe(false);
  });

  it('blocks path traversal, raw and percent-encoded', () => {
    expect(inspectRequest('/api/documents/../../etc/passwd', '').blocked).toBe(true);
    expect(inspectRequest('/static/%2e%2e/%2e%2e/secret', '').reason).toBe('path_traversal');
  });

  it('blocks null-byte injection', () => {
    expect(inspectRequest('/api/x', '?f=a%00.png').reason).toBe('null_byte');
  });

  it('blocks reflected-XSS payloads in the query', () => {
    expect(inspectRequest('/search', '?q=%3Cscript%3Ealert(1)%3C/script%3E').reason).toBe('xss_payload');
    expect(inspectRequest('/x', '?u=javascript:alert(1)').reason).toBe('xss_payload');
  });

  it('blocks scanner probes for secrets that this app never serves', () => {
    expect(inspectRequest('/.env', '').reason).toBe('probe_path');
    expect(inspectRequest('/.git/config', '').reason).toBe('probe_path');
    expect(inspectRequest('/wp-login.php', '').reason).toBe('probe_path');
  });

  it('does not mistake legitimate dotted filenames for probes', () => {
    expect(inspectRequest('/api/documents/invoice.pdf', '').blocked).toBe(false);
    expect(inspectRequest('/env-report', '').blocked).toBe(false);
  });
});

/**
 * A deliberately small, low-false-positive request filter — the application's
 * own first pass at the traffic a network WAF would catch. It is NOT a
 * replacement for Cloudflare/Vercel/AWS WAF (deploy behind one; see the README),
 * but it means a bare deployment still turns away the loudest automated abuse:
 * path traversal, null-byte tricks, blatant reflected-XSS payloads, and the
 * scanner probes for secrets that never belong to this app (.env, .git, wp-admin).
 *
 * The rules run against the DECODED path+query, so percent-encoded evasions are
 * normalized first. Everything here is chosen to never trip on the ERP's real
 * traffic — UUIDs, numeric ids, ISO dates, and ordinary query params pass
 * cleanly; only unambiguous attack shapes match. Legitimate app injection
 * defense stays where it belongs (Zod validation + parameterized SQL + RLS);
 * this just sheds obvious garbage early.
 */

export interface WafVerdict {
  blocked: boolean;
  /** Short machine-ish reason for logging when blocked. */
  reason?: string;
  rule?: string;
}

const ALLOW: WafVerdict = { blocked: false };

// Sensitive paths this app never serves — requests for them are always hostile
// scans. Matched on the raw pathname (case-insensitive).
const PROBE_PATHS = [
  /(^|\/)\.env(\.|$|\/)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /\/wp-admin(\/|$)/i,
  /\/wp-login\.php/i,
  /\/phpmyadmin/i,
  /\/vendor\/phpunit/i,
];

// Blatant payload shapes in the decoded URL. Kept tight on purpose.
const TRAVERSAL = /(\.\.\/|\.\.\\|%2e%2e)/i; // ../  ..\  and the encoded form
const NULL_BYTE = /\x00|%00/i;
const XSS = /(<script\b|javascript:|\bon(error|load|click)\s*=)/i;

function safeDecode(s: string): string {
  // Decode repeatedly so DOUBLE-encoded evasions (e.g. %253Cscript -> %3Cscript ->
  // <script) are normalized before the payload checks run. Bounded to avoid loops.
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      // A malformed %-sequence is itself suspicious; keep the last good value so the
      // null-byte / traversal checks can still see the literal characters.
      break;
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Inspect a request URL and decide whether to block it. `pathname` and `search`
 * come straight off the URL (search includes the leading '?'). Returns a verdict;
 * callers turn a blocked verdict into a 403.
 */
export function inspectRequest(pathname: string, search: string): WafVerdict {
  for (const rx of PROBE_PATHS) {
    if (rx.test(pathname)) return { blocked: true, reason: 'probe_path', rule: rx.source };
  }

  // Decode once for the payload checks so %2e%2e / %3Cscript evade nothing.
  const decoded = safeDecode(pathname) + safeDecode(search);

  if (NULL_BYTE.test(pathname + search) || NULL_BYTE.test(decoded)) {
    return { blocked: true, reason: 'null_byte', rule: 'NULL_BYTE' };
  }
  if (TRAVERSAL.test(pathname + search) || TRAVERSAL.test(decoded)) {
    return { blocked: true, reason: 'path_traversal', rule: 'TRAVERSAL' };
  }
  if (XSS.test(decoded)) {
    return { blocked: true, reason: 'xss_payload', rule: 'XSS' };
  }

  return ALLOW;
}

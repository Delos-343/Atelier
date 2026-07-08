/**
 * Serialise a header row and body rows to CSV text. Fields containing a comma, double
 * quote, or newline are wrapped in double quotes with embedded quotes doubled, per the
 * usual RFC-4180 convention; everything else is emitted bare. Null/undefined become an
 * empty field. Lines are joined with CRLF, which spreadsheets read most reliably.
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  return lines.join('\r\n');
}

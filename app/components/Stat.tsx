/**
 * A single at-a-glance metric card: a large mono figure, an uppercase label,
 * and an optional sub-line. Presentational only — callers pass a pre-formatted
 * `value` string (e.g. via `money()` from '@/lib/format').
 *
 * Extracted from the production-cost and sales-detail pages, which each carried
 * a byte-identical copy of this markup.
 */
export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="mono text-[1.4rem] font-semibold leading-none">{value}</div>
      <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">{label}</div>
      {sub && <div className="mt-1 text-[0.72rem] text-muted">{sub}</div>}
    </div>
  );
}

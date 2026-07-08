'use client';

import type { ReactNode } from 'react';
import { useCountUp, useMounted, usePrefersReducedMotion } from './useAnim';

export interface Segment {
  label: string;
  value: number;
  color: string; // CSS color (var(--…))
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
const fmtMoney = (n: number): string =>
  Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtPct = (n: number): string => `${Math.round(n)}%`;

type StatFormat = 'int' | 'money' | 'percent';

export function StatCard({
  label,
  value,
  format = 'int',
  hint,
}: {
  label: string;
  value: number;
  format?: StatFormat;
  hint?: string;
}) {
  const animated = useCountUp(value);
  const text =
    format === 'money' ? fmtMoney(animated) : format === 'percent' ? fmtPct(animated) : fmtInt(animated);
  return (
    <div className="card">
      <div className="mono text-[1.8rem] font-semibold leading-none tracking-[-0.02em]">
        {format === 'money' && <span className="mr-0.5 text-[0.95rem] text-muted">≈</span>}
        {text}
      </div>
      <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">{label}</div>
      {hint && <div className="mt-0.5 text-[0.75rem] text-text-soft">{hint}</div>}
    </div>
  );
}

function ChartCard({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-[1.02rem] font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[0.85rem] text-muted">{children}</p>;
}

/** Horizontal bars (counts). */
export function HBars({ items, unit }: { items: Segment[]; unit?: string }) {
  const mounted = useMounted();
  const reduced = usePrefersReducedMotion();
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) return <EmptyNote>No data yet.</EmptyNote>;

  return (
    <div className="flex flex-col gap-3">
      {items.map((it) => {
        const pct = (it.value / max) * 100;
        return (
          <div key={it.label} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3">
            <span className="truncate text-[0.82rem] text-text-soft">{it.label}</span>
            <span className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full rounded-full"
                style={{
                  width: mounted ? `${pct}%` : '0%',
                  backgroundColor: it.color,
                  transition: reduced ? 'none' : 'width 800ms cubic-bezier(.2,.8,.2,1)',
                }}
              />
            </span>
            <span className="mono w-12 text-right text-[0.82rem]">
              {fmtInt(it.value)}
              {unit ? <span className="ml-0.5 text-muted">{unit}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Vertical bars (values). */
export function VBars({ items, money = false }: { items: Segment[]; money?: boolean }) {
  const mounted = useMounted();
  const reduced = usePrefersReducedMotion();
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) return <EmptyNote>No data yet.</EmptyNote>;

  return (
    <div className="flex h-44 items-end gap-3">
      {items.map((it) => {
        const pct = (it.value / max) * 100;
        return (
          <div key={it.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <span className="mono text-[0.74rem] text-text-soft">
              {money ? fmtMoney(it.value) : fmtInt(it.value)}
            </span>
            <span className="flex h-full w-full items-end">
              <span
                className="block w-full rounded-t"
                style={{
                  height: mounted ? `${Math.max(2, pct)}%` : '0%',
                  backgroundColor: it.color,
                  transition: reduced ? 'none' : 'height 800ms cubic-bezier(.2,.8,.2,1)',
                }}
              />
            </span>
            <span className="w-full truncate text-center text-[0.72rem] text-muted" title={it.label}>
              {it.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Donut with an animated sweep and a centered figure. */
export function Donut({
  segments,
  centerValue,
  centerLabel,
}: {
  segments: Segment[];
  centerValue: string;
  centerLabel: string;
}) {
  const mounted = useMounted();
  const reduced = usePrefersReducedMotion();
  const total = segments.reduce((s, x) => s + x.value, 0);

  let cumulative = 0;
  return (
    <div className="flex items-center gap-5">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
          <circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--surface-2)" strokeWidth="3.5" />
          {total > 0 &&
            segments.map((seg) => {
              const pct = (seg.value / total) * 100;
              const offset = -cumulative;
              cumulative += pct;
              return (
                <circle
                  key={seg.label}
                  cx="18"
                  cy="18"
                  r="15.9155"
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="3.5"
                  pathLength={100}
                  strokeDasharray={`${mounted ? pct : 0} ${100 - (mounted ? pct : 0)}`}
                  strokeDashoffset={offset}
                  style={{ transition: reduced ? 'none' : 'stroke-dasharray 850ms ease' }}
                />
              );
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="mono text-[1.25rem] font-semibold leading-none">{centerValue}</span>
          <span className="mt-1 text-[0.66rem] uppercase tracking-[0.06em] text-muted">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[0.83rem]">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-text-soft">{s.label}</span>
            <span className="mono ml-auto pl-3">{fmtInt(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { ChartCard, fmtInt, fmtMoney, fmtPct };

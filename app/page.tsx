import Link from 'next/link';
import type { ReactNode } from 'react';
import { getPublicMetrics, type PublicMetrics } from '@/server/public-metrics';
import { getUserAndRole } from '@/lib/auth/session';

interface Module {
  no: string;
  name: string;
  role: string;
  flow: string;
}

const MODULES: Module[] = [
  { no: '01', name: 'Formulas', role: 'Versioned bills of materials', flow: 'Locked recipes, scaled exactly to any batch size.' },
  { no: '02', name: 'Production', role: 'Batch orders & completion', flow: 'Consumes raw lots FEFO, yields a finished lot in quarantine.' },
  { no: '03', name: 'Quality', role: 'Release gating', flow: 'Pass releases the lot to stock; reject holds it.' },
  { no: '04', name: 'Inventory', role: 'Lot-tracked stock', flow: 'Append-only ledger, expiry, full genealogy.' },
];

function StatCard({ value, label }: { value: string; label: string }): ReactNode {
  return (
    <div className="card">
      <div className="mono text-[1.9rem] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">{label}</div>
    </div>
  );
}

function StatusMix({ m }: { m: PublicMetrics }) {
  const other = Math.max(0, m.lotsTotal - m.lotsAvailable - m.lotsQuarantine);
  const total = m.lotsTotal || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  const segments = [
    { label: 'Available', n: m.lotsAvailable, cls: 'bg-accent' },
    { label: 'Quarantine', n: m.lotsQuarantine, cls: 'bg-warn' },
    { label: 'Other', n: other, cls: 'bg-muted' },
  ];
  return (
    <div className="card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[1.05rem] font-semibold">Stock status</h2>
        <span className="text-[0.8rem] text-muted">{m.lotsTotal} lots</span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
        {segments.map((s) => (
          <div key={s.label} className={s.cls} style={{ width: pct(s.n) }} aria-label={`${s.label}: ${s.n}`} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-[0.82rem] text-text-soft">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.cls}`} aria-hidden="true" />
            {s.label} · {s.n}
          </span>
        ))}
      </div>
    </div>
  );
}

export default async function Home() {
  const [metrics, { user }] = await Promise.all([getPublicMetrics(), getUserAndRole()]);
  const passRate = metrics?.qcPassRate == null ? '—' : `${Math.round(metrics.qcPassRate * 100)}%`;

  return (
    <main className="mx-auto max-w-content px-5 pb-16 pt-[clamp(2.25rem,6vw,4rem)]">
      <header className="border-b border-border pb-9">
        <p className="text-[0.72rem] uppercase tracking-[0.22em] text-accent">TFI · Manufacturing &amp; Distribution</p>
        <h1 className="mb-[0.9rem] mt-[0.6rem] text-[clamp(2.6rem,10vw,5rem)] font-semibold leading-[0.96] tracking-[-0.03em]">
          TechnicoFlor
        </h1>
        <p className="prose-justify max-w-full text-[clamp(1rem,2.4vw,1.12rem)] text-text-soft">
          A perfume manufacturing system built on a verified core - a formula becomes a batch, a
          batch becomes traceable stock, and nothing silently goes negative. This page is open to
          everyone; the operational console is behind sign-in.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {user ? (
            <Link href="/app" className="btn">Enter console</Link>
          ) : (
            <Link href="/login" className="btn">Sign in to the console</Link>
          )}
        </div>
      </header>

      <section className="py-9" aria-label="Live operations">
        <h2 className="section-label mb-4">Live operations</h2>
        {metrics ? (
          <>
            <div className="mb-4 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
              <StatCard value={String(metrics.productsTotal)} label="Products" />
              <StatCard value={String(metrics.materialsTotal)} label="Raw materials" />
              <StatCard value={String(metrics.lotsTotal)} label="Lots in stock" />
              <StatCard value={String(metrics.productionTotal)} label="Production orders" />
              <StatCard value={String(metrics.productionCompleted)} label="Completed batches" />
              <StatCard value={passRate} label="QC pass rate" />
            </div>
            <StatusMix m={metrics} />
          </>
        ) : (
          <div className="rounded border border-dashed border-border-strong bg-surface p-6 text-muted">
            Live metrics aren&rsquo;t available right now. Connect a backend (and seed demo data with{' '}
            <span className="mono">yarn db:seed</span>) to populate this dashboard.
          </div>
        )}
      </section>

      <section
        className="grid gap-px overflow-hidden rounded border border-border bg-border [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]"
        aria-label="Modules"
      >
        {MODULES.map((mod) => (
          <article key={mod.no} className="flex gap-4 bg-surface p-6">
            <span className="pt-[0.15rem] font-mono text-[0.9rem] text-accent">{mod.no}</span>
            <div>
              <h3 className="text-[1.1rem] font-semibold tracking-[-0.01em]">{mod.name}</h3>
              <p className="mb-[0.6rem] mt-[0.15rem] text-[0.8rem] text-muted">{mod.role}</p>
              <p className="text-[0.92rem] text-text-soft">{mod.flow}</p>
            </div>
          </article>
        ))}
      </section>

      <footer className="mt-8 text-[0.82rem] text-muted">
        © 1981 – 2026 TechnicoFlor &nbsp; | &nbsp; All Rights Reserved.
      </footer>
    </main>
  );
}

'use client';

import type { DashboardMetrics } from '@/server/dashboard';
import { ChartCard, Donut, HBars, StatCard, VBars, type Segment } from './charts';

const STATUS_COLOR: Record<string, string> = {
  available: 'var(--ok)',
  quarantine: 'var(--warn)',
  expired: 'var(--bad)',
  consumed: 'var(--muted)',
  rejected: 'var(--bad)',
};
const STATUS_ORDER = ['available', 'quarantine', 'expired', 'consumed', 'rejected'];

const PROD_COLOR: Record<string, string> = {
  planned: 'var(--muted)',
  in_progress: 'var(--accent)',
  completed: 'var(--ok)',
  cancelled: 'var(--bad)',
};
const PROD_ORDER = ['planned', 'in_progress', 'completed', 'cancelled'];

const CATEGORY_PALETTE = ['var(--accent)', 'var(--accent-2)', 'var(--ok)', 'var(--warn)', 'var(--bad)', 'var(--muted)'];

const prettify = (s: string): string => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function Dashboard({ metrics }: { metrics: DashboardMetrics | null }) {
  if (!metrics) {
    return (
      <div className="rounded border border-dashed border-border-strong bg-surface p-6 text-muted">
        Dashboard data isn&rsquo;t available right now. Connect a backend (and seed demo data with{' '}
        <span className="mono">yarn db:seed</span>) to light up these charts.
      </div>
    );
  }

  const { inventory, production, qc } = metrics;

  const statusBars: Segment[] = STATUS_ORDER.filter((s) => (inventory.lotsByStatus[s] ?? 0) > 0).map(
    (s) => ({ label: prettify(s), value: inventory.lotsByStatus[s] ?? 0, color: STATUS_COLOR[s] ?? 'var(--muted)' }),
  );

  const categoryBars: Segment[] = inventory.valueByCategory.map((c, i) => ({
    label: prettify(c.category),
    value: c.value,
    color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));

  const pipelineBars: Segment[] = PROD_ORDER.map((s) => ({
    label: prettify(s),
    value: production.byStatus[s] ?? 0,
    color: PROD_COLOR[s] ?? 'var(--muted)',
  }));

  const qcSegments: Segment[] = [
    { label: 'Passed', value: qc.passed, color: 'var(--ok)' },
    { label: 'Failed', value: qc.failed, color: 'var(--bad)' },
    { label: 'Pending', value: qc.pending, color: 'var(--warn)' },
  ];
  const passPct = qc.passRate == null ? null : qc.passRate * 100;

  const availableLots = inventory.lotsByStatus.available ?? 0;
  const inProgress = production.byStatus.in_progress ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
        <StatCard label="Inventory value" value={inventory.valueTotal} format="money" />
        <StatCard label="Finished goods" value={inventory.valueFinished} format="money" />
        <StatCard label="Available lots" value={availableLots} format="int" />
        <StatCard label="Orders in progress" value={inProgress} format="int" />
        {passPct == null ? (
          <div className="card">
            <div className="mono text-[1.8rem] font-semibold leading-none text-muted">—</div>
            <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">QC pass rate</div>
          </div>
        ) : (
          <StatCard label="QC pass rate" value={passPct} format="percent" />
        )}
      </div>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
        <ChartCard title="Inventory by status">
          <HBars items={statusBars} />
        </ChartCard>

        <ChartCard title="Quality control">
          <Donut
            segments={qcSegments}
            centerValue={passPct == null ? '—' : `${Math.round(passPct)}%`}
            centerLabel="pass rate"
          />
        </ChartCard>

        <ChartCard title="Inventory value by material">
          <VBars items={categoryBars} money />
        </ChartCard>

        <ChartCard
          title="Production pipeline"
          right={<span className="text-[0.8rem] text-muted">{production.total} orders</span>}
        >
          <HBars items={pipelineBars} />
        </ChartCard>
      </div>
    </div>
  );
}

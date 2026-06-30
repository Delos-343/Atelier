'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import type { ProductionOrderCost, CostLine } from '@/server/costing';
import { money } from '@/lib/format';

const STATUS_CLASS: Record<string, string> = {
  planned: 'badge-mute',
  in_progress: 'badge-warn',
  completed: 'badge-ok',
  cancelled: 'badge-bad',
};

const lineColumns: Column<CostLine>[] = [
  {
    key: 'material',
    header: 'Material',
    render: (l) => (
      <span>
        <span className="mono">{l.sku}</span> <span className="text-soft">{l.name}</span>
      </span>
    ),
  },
  {
    key: 'consumed',
    header: 'Consumed',
    align: 'right',
    render: (l) => (
      <span className="mono">
        {l.consumedQuantity} {l.unit}
      </span>
    ),
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    render: (l) => <span className="mono">{money(l.lineCost)}</span>,
  },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="mono text-[1.4rem] font-semibold leading-none">{value}</div>
      <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">{label}</div>
    </div>
  );
}

export default function ProductionOrderCostPage() {
  const params = useParams<{ id: string }>();
  const { data: c, error, loading } = useApiData<ProductionOrderCost>(
    `/api/production/${params.id}/cost`,
  );

  const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

  return (
    <Page>
      <PageHeader title="Production order cost">
        Actual material cost rolled up from consumptions and frozen at completion.
      </PageHeader>

      <Link href="/app/production" className="text-[0.85rem] text-muted hover:text-text">
        ← All orders
      </Link>

      <div className="mt-4">
        {loading && !c ? (
          <p className={stateBox}>Loading…</p>
        ) : error && !c ? (
          <p className={stateBox}>Could not load — {error}</p>
        ) : !c ? (
          <p className={stateBox}>No cost data for this order.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <span className="mono text-[1.1rem]">{c.code}</span>
              <span className={`badge ${STATUS_CLASS[c.status] ?? ''}`}>{c.status}</span>
            </div>

            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
              <Stat label="Total material cost" value={money(c.totalCost)} />
              <Stat
                label={`Unit cost / ${c.unit}`}
                value={c.unitCost == null ? '—' : money(c.unitCost)}
              />
              <Stat label="Output quantity" value={`${c.outputQuantity} ${c.unit}`} />
            </div>

            {c.lines.length === 0 ? (
              <p className="text-[0.9rem] text-muted">
                No consumptions recorded
                {c.status !== 'completed'
                  ? ' — costs are computed when the order is completed.'
                  : '.'}
              </p>
            ) : (
              <div>
                <h2 className="section-label mb-[0.85rem]">Cost by material</h2>
                <DataTable columns={lineColumns} rows={c.lines} rowKey={(l) => l.rawMaterialId} />
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

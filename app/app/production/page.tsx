'use client';

import { Page, PageHeader } from '../../components/Page';
import Link from 'next/link';
import { useApiData } from '../../components/offline/useApiData';
import { AsyncView } from '../../components/offline/AsyncView';
import { DataTable, type Column } from '../../components/DataTable';
import { NewProductionOrderForm } from '../../components/NewProductionOrderForm';

interface Order {
  id: string;
  code: string;
  status: string;
  planned_quantity: string;
  unit: string;
  created_at: string;
  completed_at: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  planned: 'badge-mute',
  in_progress: 'badge-warn',
  completed: 'badge-ok',
  cancelled: 'badge-bad',
};

const columns: Column<Order>[] = [
  { key: 'code', header: 'Code', render: (o) => <Link href={`/app/production/${o.id}`} className="mono text-accent hover:underline">{o.code}</Link> },
  { key: 'planned', header: 'Planned', align: 'right', render: (o) => <span className="mono">{o.planned_quantity} {o.unit}</span> },
  { key: 'status', header: 'Status', render: (o) => <span className={`badge ${STATUS_CLASS[o.status] ?? ''}`}>{o.status}</span> },
  { key: 'completed', header: 'Completed', align: 'right', render: (o) => <span className="mono">{o.completed_at ? o.completed_at.slice(0, 10) : '—'}</span> },
];

export default function ProductionPage() {
  const state = useApiData<Order[]>('/api/production');
  return (
    <Page>
      <PageHeader title="Production">
        Batch orders consume raw lots FEFO and yield a finished lot held for quality control.
      </PageHeader>

      <NewProductionOrderForm onSubmitted={state.reload} />

      <h2 className="section-label mb-[0.85rem] mt-9">Orders</h2>
      <AsyncView state={state} empty="No production orders yet.">
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(o) => o.id} />}
      </AsyncView>
    </Page>
  );
}

'use client';

import Link from 'next/link';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { AsyncView } from '../../components/offline/AsyncView';
import { DataTable, type Column } from '../../components/DataTable';

interface Lot {
  id: string;
  lot_code: string;
  item_type: string;
  status: string;
  quantity_on_hand: string;
  unit: string;
  expiry_date: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  available: 'badge-ok',
  quarantine: 'badge-warn',
  expired: 'badge-bad',
  rejected: 'badge-bad',
  consumed: 'badge-mute',
};

const columns: Column<Lot>[] = [
  {
    key: 'lot_code',
    header: 'Lot',
    render: (l) => (
      <Link href={`/app/inventory/${l.id}`} className="rowlink mono">
        {l.lot_code}
      </Link>
    ),
  },
  { key: 'item_type', header: 'Type' },
  { key: 'qty', header: 'On hand', align: 'right', render: (l) => <span className="mono">{l.quantity_on_hand} {l.unit}</span> },
  { key: 'expiry_date', header: 'Expiry', align: 'right', render: (l) => <span className="mono">{l.expiry_date ?? '—'}</span> },
  { key: 'status', header: 'Status', render: (l) => <span className={`badge ${STATUS_CLASS[l.status] ?? ''}`}>{l.status}</span> },
];

export default function InventoryPage() {
  const state = useApiData<Lot[]>('/api/inventory');
  return (
    <Page>
      <PageHeader title="Inventory">
        Every lot tracked against an append-only ledger. Select a lot to trace its genealogy.
      </PageHeader>
      <AsyncView state={state} empty="No lots in stock.">
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(l) => l.id} />}
      </AsyncView>
    </Page>
  );
}

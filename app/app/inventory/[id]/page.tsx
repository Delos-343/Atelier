'use client';

import Link from 'next/link';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge, LOT_STATUS_TONES } from '../../../components/StatusBadge';

interface Movement {
  id: string;
  movement_type: string;
  quantity: string;
  unit: string;
  reference_type: string | null;
  created_at: string;
}
interface TraceNode { lot_id: string; lot_code: string; depth: number; quantity: string; unit: string }
interface LotDetail {
  lot: {
    id: string; lot_code: string; item_type: string; status: string;
    quantity_on_hand: string; unit: string; expiry_date: string | null;
  } | null;
  movements: Movement[];
  ancestors: TraceNode[];
  descendants: TraceNode[];
}

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

const ledgerColumns: Column<Movement>[] = [
  { key: 'when', header: 'When', render: (m) => <span className="mono">{m.created_at.slice(0, 19).replace('T', ' ')}</span> },
  { key: 'type', header: 'Type', render: (m) => m.movement_type },
  {
    key: 'change',
    header: 'Change',
    align: 'right',
    render: (m) => (
      <span className={`font-mono text-[0.84rem] ${Number(m.quantity) < 0 ? 'text-bad' : 'text-ok'}`}>
        {Number(m.quantity) > 0 ? '+' : ''}
        {m.quantity} {m.unit}
      </span>
    ),
  },
  { key: 'ref', header: 'Reference', render: (m) => m.reference_type ?? '—' },
];

function TraceList({ nodes, empty }: { nodes: TraceNode[]; empty: string }) {
  if (nodes.length === 0) return <p className="py-2 text-[0.88rem] text-muted">{empty}</p>;
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={`${n.lot_id}-${n.depth}`} style={{ paddingLeft: `${(n.depth - 1) * 1.25}rem` }}>
          <span className="mono">{n.lot_code}</span>
          <span className="font-mono text-[0.82rem] text-text-soft">{n.quantity} {n.unit}</span>
          {n.depth > 1 && <span className="text-[0.74rem] text-muted">· level {n.depth}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function LotPage({ params }: { params: { id: string } }) {
  const { data, error, loading } = useApiData<LotDetail>(`/api/lots/${params.id}`);

  return (
    <main className="mx-auto max-w-content px-5 pb-16 pt-[clamp(1.75rem,5vw,3rem)]">
      <Link href="/app/inventory" className="backlink">← Inventory</Link>

      {loading && !data ? (
        <p className={STATE}>Loading…</p>
      ) : error && !data ? (
        <p className={STATE}>Could not load lot — {error}</p>
      ) : !data || !data.lot ? (
        <p className={STATE}>Lot not found.</p>
      ) : (
        <>
          <header className="mb-7 flex flex-wrap items-center gap-4">
            <h1 className="mono text-[clamp(1.7rem,4.5vw,2.4rem)] font-semibold leading-[1.1]">{data.lot.lot_code}</h1>
            <StatusBadge value={data.lot.status} tones={LOT_STATUS_TONES} />
          </header>

          <dl className="mb-8 flex flex-wrap gap-x-10 gap-y-6 border-b border-border pb-6">
            <div>
              <dt className="label">On hand</dt>
              <dd className="mono mt-1 text-[1.05rem]">{data.lot.quantity_on_hand} {data.lot.unit}</dd>
            </div>
            <div>
              <dt className="label">Type</dt>
              <dd className="mt-1 text-[1.05rem]">{data.lot.item_type}</dd>
            </div>
            <div>
              <dt className="label">Expiry</dt>
              <dd className="mono mt-1 text-[1.05rem]">{data.lot.expiry_date ?? '—'}</dd>
            </div>
          </dl>

          <section className="mb-9 grid gap-x-8 gap-y-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
            <div>
              <h2 className="section-label mb-[0.85rem]">Made from</h2>
              <TraceList nodes={data.ancestors} empty="No source lots (received stock)." />
            </div>
            <div>
              <h2 className="section-label mb-[0.85rem]">Used in</h2>
              <TraceList nodes={data.descendants} empty="Not yet consumed into another lot." />
            </div>
          </section>

          <h2 className="section-label mb-[0.85rem] mt-9">Movement ledger</h2>
          {data.movements.length === 0 ? (
            <p className={STATE}>No movements.</p>
          ) : (
            <DataTable columns={ledgerColumns} rows={data.movements} rowKey={(m) => m.id} />
          )}
        </>
      )}
    </main>
  );
}

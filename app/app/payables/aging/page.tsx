'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { useRole } from '../../../components/auth/SessionProvider';
import { Stat } from '../../../components/Stat';
import { money } from '@/lib/format';
import { AGING_BUCKETS, AGING_BUCKET_LABEL as BUCKET_LABEL } from '@/server/receivables';
import type { AgedBill, SupplierAging, PayablesAgingSummary } from '@/server/payables';

const bucketCell = (v: number) =>
  v > 0 ? <span className="mono">{money(v)}</span> : <span className="text-muted">—</span>;

const scheduleColumns: Column<AgedBill>[] = [
  { key: 'number', header: 'Bill', render: (b) => <span className="mono">{b.billNumber}</span> },
  { key: 'billed', header: 'Billed', render: (b) => <span className="mono">{b.billDate.slice(0, 10)}</span> },
  {
    key: 'due',
    header: 'Due',
    render: (b) => (
      <span className={`mono ${b.daysOverdue > 0 ? 'text-bad' : 'text-muted'}`}>
        {b.dueDate.slice(0, 10)}
        {b.daysOverdue > 0 ? ` · ${b.daysOverdue}d` : ''}
      </span>
    ),
  },
  { key: 'bucket', header: 'Bucket', render: (b) => BUCKET_LABEL[b.bucket] },
  { key: 'open', header: 'Balance', align: 'right', render: (b) => <span className="mono">{money(b.open)}</span> },
];

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function PayablesAgingPage() {
  const role = useRole();
  const state = useApiData<{ suppliers: SupplierAging[]; summary: PayablesAgingSummary }>(
    '/api/payables/aging',
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (role && role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Payables aging">What we owe, by age.</PageHeader>
        <p className={STATE}>The payables aging report is visible to administrators only.</p>
      </Page>
    );
  }

  const data = state.data;
  const suppliers = data?.suppliers ?? [];
  const selectedSupplier = suppliers.find((s) => s.supplierId === selected) ?? null;

  const columns: Column<SupplierAging>[] = [
    {
      key: 'supplier',
      header: 'Supplier',
      render: (s) => (
        <button
          type="button"
          className="text-left text-accent hover:underline"
          onClick={() => setSelected(selected === s.supplierId ? null : s.supplierId)}
        >
          {s.supplierName}
        </button>
      ),
    },
    ...AGING_BUCKETS.map(
      (b): Column<SupplierAging> => ({
        key: b,
        header: BUCKET_LABEL[b],
        align: 'right',
        render: (s) => bucketCell(s.buckets[b]),
      }),
    ),
    {
      key: 'open',
      header: 'Total',
      align: 'right',
      render: (s) => <span className="mono font-medium">{money(s.open)}</span>,
    },
  ];

  return (
    <Page>
      <PageHeader title="Payables aging">
        What we owe each supplier, by how far past due — a lens on the same bills, so it never drifts
        from the payables register. Aged from each bill&apos;s due date.{' '}
        <Link href="/app/payables" className="text-accent hover:underline">
          ← Back to payables
        </Link>
      </PageHeader>

      {data && (
        <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr))]">
          {AGING_BUCKETS.map((b) => (
            <Stat key={b} label={BUCKET_LABEL[b]} value={money(data.summary.buckets[b])} />
          ))}
          <Stat
            label="Owed"
            value={money(data.summary.open)}
            sub={`${data.summary.supplierCount} supplier${data.summary.supplierCount === 1 ? '' : 's'}`}
          />
        </div>
      )}

      {state.loading && !data ? (
        <p className={STATE}>Loading…</p>
      ) : state.error && !data ? (
        <p className={STATE}>Could not load — {state.error}</p>
      ) : suppliers.length === 0 ? (
        <p className={STATE}>Nothing owed — every bill is settled or voided.</p>
      ) : (
        <>
          <DataTable columns={columns} rows={suppliers} rowKey={(s) => s.supplierId} />
          <p className="mt-3 text-[0.8rem] text-muted">
            As of {data?.summary.asOf}. Select a supplier to see the bills behind the total. Buckets are
            days past due: Current is not yet due, then 1–30, 31–60, 61–90, and over 90.
          </p>
        </>
      )}

      {selectedSupplier && (
        <div className="card mt-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="text-[1.05rem] font-semibold text-text">{selectedSupplier.supplierName}</h3>
            <span className="text-[0.85rem] text-muted">
              {selectedSupplier.bills.length} open · {money(selectedSupplier.open)} owed
            </span>
          </div>
          <DataTable columns={scheduleColumns} rows={selectedSupplier.bills} rowKey={(b) => b.billId} />
        </div>
      )}
    </Page>
  );
}

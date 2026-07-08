'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { useRole } from '../../../components/auth/SessionProvider';
import { Stat } from '../../../components/Stat';
import { money } from '@/lib/format';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABEL as BUCKET_LABEL,
  type AgingBucket,
  type AgedInvoice,
  type CustomerAging,
  type ReceivablesAgingSummary,
} from '@/server/receivables';

const bucketCell = (v: number) =>
  v > 0 ? <span className="mono">{money(v)}</span> : <span className="text-muted">—</span>;

const statementColumns: Column<AgedInvoice>[] = [
  {
    key: 'number',
    header: 'Invoice',
    render: (i) => (
      <a
        href={`/api/issued-documents/${i.issuedDocumentId}?format=pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="mono text-accent hover:underline"
      >
        {i.documentNumber}
      </a>
    ),
  },
  { key: 'issued', header: 'Issued', render: (i) => <span className="mono">{i.issuedAt.slice(0, 10)}</span> },
  {
    key: 'due',
    header: 'Due',
    render: (i) => (
      <span className={`mono ${i.daysOverdue > 0 ? 'text-bad' : 'text-muted'}`}>
        {i.dueDate.slice(0, 10)}
        {i.daysOverdue > 0 ? ` · ${i.daysOverdue}d` : ''}
      </span>
    ),
  },
  { key: 'bucket', header: 'Bucket', render: (i) => BUCKET_LABEL[i.bucket] },
  { key: 'open', header: 'Balance', align: 'right', render: (i) => <span className="mono">{money(i.open)}</span> },
];

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function ReceivablesAgingPage() {
  const role = useRole();
  const state = useApiData<{ customers: CustomerAging[]; summary: ReceivablesAgingSummary }>(
    '/api/receivables/aging',
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (role && role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Aging report">Outstanding balances by age.</PageHeader>
        <p className={STATE}>The aging report is visible to administrators only.</p>
      </Page>
    );
  }

  const data = state.data;
  const customers = data?.customers ?? [];
  const selectedCustomer = customers.find((c) => c.customerId === selected) ?? null;

  const columns: Column<CustomerAging>[] = [
    {
      key: 'customer',
      header: 'Customer',
      render: (c) => (
        <button
          type="button"
          className="text-left text-accent hover:underline"
          onClick={() => setSelected(selected === c.customerId ? null : c.customerId)}
        >
          {c.customerName}
        </button>
      ),
    },
    ...AGING_BUCKETS.map(
      (b): Column<CustomerAging> => ({
        key: b,
        header: BUCKET_LABEL[b],
        align: 'right',
        render: (c) => bucketCell(c.buckets[b]),
      }),
    ),
    {
      key: 'open',
      header: 'Total',
      align: 'right',
      render: (c) => <span className="mono font-medium">{money(c.open)}</span>,
    },
  ];

  return (
    <Page>
      <PageHeader title="Aging report">
        Outstanding invoice balances by age, per customer — a lens on the same receivables, so it never
        drifts from what each order&apos;s page shows. Aged from the issue date.{' '}
        <Link href="/app/receivables" className="text-accent hover:underline">
          ← Back to receivables
        </Link>
      </PageHeader>

      {data && (
        <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr))]">
          {AGING_BUCKETS.map((b) => (
            <Stat key={b} label={BUCKET_LABEL[b]} value={money(data.summary.buckets[b])} />
          ))}
          <Stat
            label="Outstanding"
            value={money(data.summary.open)}
            sub={`${data.summary.customerCount} customer${data.summary.customerCount === 1 ? '' : 's'}`}
          />
        </div>
      )}

      {state.loading && !data ? (
        <p className={STATE}>Loading…</p>
      ) : state.error && !data ? (
        <p className={STATE}>Could not load — {state.error}</p>
      ) : customers.length === 0 ? (
        <p className={STATE}>Nothing outstanding — every issued invoice is settled or voided.</p>
      ) : (
        <>
          <DataTable columns={columns} rows={customers} rowKey={(c) => c.customerId} />
          <p className="mt-3 text-[0.8rem] text-muted">
            As of {data?.summary.asOf}. Select a customer to see their statement of open invoices. Buckets
            are days since issue: Current 0–30, then 31–60, 61–90, and over 90.
          </p>
        </>
      )}

      {selectedCustomer && (
        <div className="card mt-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="text-[1.05rem] font-semibold text-text">
              Statement — {selectedCustomer.customerName}
            </h3>
            <span className="flex items-center gap-3">
              <span className="text-[0.85rem] text-muted">
                {selectedCustomer.invoices.length} open · {money(selectedCustomer.open)} outstanding
              </span>
              <a
                className="btn btn-sm btn-ghost"
                href={`/api/receivables/statement/${selectedCustomer.customerId}?format=pdf${data ? `&asOf=${data.summary.asOf}` : ''}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download statement
              </a>
            </span>
          </div>
          <DataTable
            columns={statementColumns}
            rows={selectedCustomer.invoices}
            rowKey={(i) => i.issuedDocumentId}
          />
        </div>
      )}
    </Page>
  );
}

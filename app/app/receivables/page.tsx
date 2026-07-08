'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { DataTable, type Column } from '../../components/DataTable';
import { useRole } from '../../components/auth/SessionProvider';
import { Stat } from '../../components/Stat';
import { StatusBadge, RECEIVABLE_STATUS_TONES, RECEIVABLE_STATUS_LABEL } from '../../components/StatusBadge';
import { money } from '@/lib/format';
import type { ReceivableInvoice, ReceivablesSummary } from '@/server/receivables';

type Filter = 'outstanding' | 'open' | 'partially_paid' | 'paid' | 'void' | 'all';

const FILTER_LABEL: Record<Filter, string> = {
  outstanding: 'Outstanding',
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
  all: 'All',
};

// "Outstanding" is the working view: anything still owed. The rest map to the
// derived status one-to-one.
const matchesFilter = (r: ReceivableInvoice, f: Filter): boolean =>
  f === 'all'
    ? true
    : f === 'outstanding'
      ? r.status === 'open' || r.status === 'partially_paid'
      : r.status === f;

const columns: Column<ReceivableInvoice>[] = [
  {
    key: 'number',
    header: 'Invoice',
    render: (r) => (
      <Link href={`/app/sales/${r.salesOrderId}`} className="mono text-accent hover:underline">
        {r.documentNumber}
      </Link>
    ),
  },
  { key: 'order', header: 'Order', render: (r) => <span className="mono">{r.orderCode}</span> },
  { key: 'customer', header: 'Customer', render: (r) => r.customerName },
  { key: 'issued', header: 'Issued', render: (r) => <span className="mono">{r.issuedAt.slice(0, 10)}</span> },
  {
    key: 'due',
    header: 'Due',
    render: (r) =>
      r.dueDate == null ? (
        <span className="text-muted">—</span>
      ) : (
        <span className={`mono ${r.overdue ? 'text-bad' : 'text-muted'}`}>{r.dueDate.slice(0, 10)}</span>
      ),
  },
  { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="mono">{money(r.total)}</span> },
  { key: 'paid', header: 'Paid', align: 'right', render: (r) => <span className="mono">{money(r.paid)}</span> },
  {
    key: 'open',
    header: 'Balance',
    align: 'right',
    render: (r) => (
      <span className={`mono ${r.status === 'void' ? 'text-muted' : r.open > 0 ? '' : 'text-ok'}`}>
        {r.status === 'void' ? '—' : money(r.open)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className="flex items-center gap-2">
        <StatusBadge value={r.status} tones={RECEIVABLE_STATUS_TONES}>
          {RECEIVABLE_STATUS_LABEL[r.status] ?? r.status}
        </StatusBadge>
        {r.overdue && <span className="badge badge-bad">overdue</span>}
      </span>
    ),
  },
];

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function ReceivablesPage() {
  const role = useRole();
  const state = useApiData<{ invoices: ReceivableInvoice[]; summary: ReceivablesSummary }>(
    '/api/receivables',
  );
  const [filter, setFilter] = useState<Filter>('outstanding');

  if (role && role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Receivables">Outstanding customer invoices and collections.</PageHeader>
        <p className={STATE}>Receivables are visible to administrators only.</p>
      </Page>
    );
  }

  const data = state.data;
  const invoices = data?.invoices ?? [];
  const rows = invoices.filter((r) => matchesFilter(r, filter));

  return (
    <Page>
      <PageHeader title="Receivables">
        Every issued invoice with what has been collected and what remains — derived from the payments
        recorded against each document, so it never drifts from the order pages.{' '}
        <Link href="/app/receivables/aging" className="text-accent hover:underline">
          View aging report →
        </Link>{' '}
        <Link href="/app/receivables/ledger" className="text-accent hover:underline">
          Customer statement →
        </Link>
      </PageHeader>

      {data && (
        <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))]">
          <Stat
            label="Outstanding"
            value={money(data.summary.outstanding)}
            sub={`across ${data.summary.openCount} invoice${data.summary.openCount === 1 ? '' : 's'}`}
          />
          <Stat label="Collected" value={money(data.summary.collected)} />
          <Stat label="Issued invoices" value={String(invoices.length)} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['outstanding', 'open', 'partially_paid', 'paid', 'void', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={`btn btn-sm ${filter === f ? '' : 'btn-ghost'}`}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {state.loading && !data ? (
        <p className={STATE}>Loading…</p>
      ) : state.error && !data ? (
        <p className={STATE}>Could not load — {state.error}</p>
      ) : rows.length === 0 ? (
        <p className={STATE}>
          {invoices.length === 0 ? 'No invoices issued yet.' : 'No invoices match this filter.'}
        </p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      )}

      {data && invoices.length > 0 && (
        <p className="mt-3 text-[0.8rem] text-muted">
          Record and correct payments from each order&apos;s page. Outstanding sums the open balance of
          unpaid and partially-paid invoices; collected sums receipts across all non-void invoices.
        </p>
      )}
    </Page>
  );
}

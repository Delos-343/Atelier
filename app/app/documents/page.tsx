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
import { toCsv } from '@/lib/csv';
import { DOCUMENT_KIND_LABEL } from '@/lib/mail/template';
import type {
  IssuedDocumentRegisterRow,
  IssuedDocumentRegisterSummary,
} from '@/server/issuedDocuments';

type KindFilter = 'all' | 'invoice' | 'packing_slip' | 'credit_note';

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'packing_slip', label: 'Packing slips' },
  { value: 'credit_note', label: 'Credit notes' },
];

const columns: Column<IssuedDocumentRegisterRow>[] = [
  {
    key: 'number',
    header: 'Number',
    render: (d) => (
      <span className="flex items-center gap-2">
        <span
          className={`mono ${d.voided ? 'text-muted line-through' : ''}`}
          title={d.voided ? d.voidReason ?? undefined : undefined}
        >
          {d.documentNumber}
        </span>
        {d.voided && <span className="badge badge-mute">void</span>}
      </span>
    ),
  },
  { key: 'kind', header: 'Kind', render: (d) => DOCUMENT_KIND_LABEL[d.kind] ?? d.kind },
  {
    key: 'order',
    header: 'Order',
    render: (d) => (
      <Link href={`/app/sales/${d.salesOrderId}`} className="mono text-accent hover:underline">
        {d.orderCode}
      </Link>
    ),
  },
  { key: 'customer', header: 'Customer', render: (d) => d.customerName },
  { key: 'issued', header: 'Issued', render: (d) => <span className="mono">{d.issuedAt.slice(0, 10)}</span> },
  { key: 'total', header: 'Total', align: 'right', render: (d) => <span className="mono">{d.total == null ? '—' : money(d.total)}</span> },
  {
    key: 'sent',
    header: 'Sent',
    render: (d) =>
      d.emailCount === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <span className="text-[0.82rem]">
          <span className="mono">{d.lastRecipient}</span>
          <span className="text-muted">
            {' '}
            · {d.lastEmailedAt?.slice(0, 10)}
            {d.emailCount > 1 ? ` · ×${d.emailCount}` : ''}
          </span>
        </span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (d) => {
      // Void is shown on the number; otherwise an invoice carries its receivable
      // status and other kinds have none.
      if (d.voided) return <span className="text-muted">—</span>;
      if (d.kind === 'invoice' && d.paymentStatus) {
        return (
          <StatusBadge value={d.paymentStatus} tones={RECEIVABLE_STATUS_TONES}>
            {RECEIVABLE_STATUS_LABEL[d.paymentStatus] ?? d.paymentStatus}
          </StatusBadge>
        );
      }
      return <span className="text-muted">—</span>;
    },
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: (d) => (
      <a
        href={`/api/issued-documents/${d.id}?format=pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline"
      >
        PDF
      </a>
    ),
  },
];

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function DocumentsRegisterPage() {
  const role = useRole();
  const state = useApiData<{
    documents: IssuedDocumentRegisterRow[];
    summary: IssuedDocumentRegisterSummary;
  }>('/api/issued-documents/register');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');

  if (role && role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Documents">Every issued invoice, packing slip, and credit note.</PageHeader>
        <p className={STATE}>The documents register is visible to administrators only.</p>
      </Page>
    );
  }

  const data = state.data;
  const documents = data?.documents ?? [];
  const needle = query.trim().toLowerCase();
  const rows = documents.filter(
    (d) =>
      (kind === 'all' || d.kind === kind) &&
      (needle === '' ||
        [d.documentNumber, d.orderCode, d.customerName].some((s) => s.toLowerCase().includes(needle))),
  );

  // Serialise the currently filtered rows to CSV and hand them off as a download —
  // exactly what is on screen, for an accounting handoff. Receivable figures apply to
  // invoices only; other kinds leave those columns blank.
  function exportCsv() {
    const csv = toCsv(
      ['Number', 'Kind', 'Order', 'Customer', 'Issued', 'Total', 'Paid', 'Balance', 'Status', 'Emailed', 'Voided'],
      rows.map((d) => [
        d.documentNumber,
        DOCUMENT_KIND_LABEL[d.kind] ?? d.kind,
        d.orderCode,
        d.customerName,
        d.issuedAt.slice(0, 10),
        d.total ?? '',
        d.kind === 'invoice' ? d.paid ?? '' : '',
        d.kind === 'invoice' ? d.open ?? '' : '',
        d.kind === 'invoice' ? d.paymentStatus ?? '' : '',
        d.emailCount,
        d.voided ? 'yes' : '',
      ]),
    );
    // Prepend a BOM so spreadsheets read UTF-8 correctly.
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `documents-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Page>
      <PageHeader title="Documents">
        Every issued invoice, packing slip, and credit note across all orders — the frozen archive with
        its send history and, for invoices, collection status. Numbers, PDFs, and payments live on each
        order&apos;s page.
      </PageHeader>

      {data && (
        <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
          <Stat
            label="Documents"
            value={String(data.summary.total)}
            sub={`${data.summary.invoices} inv · ${data.summary.packingSlips} PS · ${data.summary.creditNotes} CN`}
          />
          <Stat label="Emailed" value={String(data.summary.emailed)} />
          <Stat label="Voided" value={String(data.summary.voided)} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`btn btn-sm ${kind === f.value ? '' : 'btn-ghost'}`}
              onClick={() => setKind(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input w-full max-w-xs md:ml-auto md:w-64"
          placeholder="Search number, order, or customer"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn btn-sm btn-ghost" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      {state.loading && !data ? (
        <p className={STATE}>Loading…</p>
      ) : state.error && !data ? (
        <p className={STATE}>Could not load — {state.error}</p>
      ) : rows.length === 0 ? (
        <p className={STATE}>
          {documents.length === 0 ? 'No documents issued yet.' : 'No documents match these filters.'}
        </p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(d) => d.id} />
      )}

      {data && documents.length > 0 && rows.length > 0 && (
        <p className="mt-3 text-[0.8rem] text-muted">
          Showing {rows.length} of {documents.length}. A struck-through number is a voided document; hover
          it for the reason. Status reflects an invoice&apos;s collection state — record payments from the
          order page.
        </p>
      )}
    </Page>
  );
}

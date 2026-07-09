'use client';

import { useMemo, useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import type { EmailHistoryEntry } from '@/server/emailHistory';

const DOC_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  packing_slip: 'Packing slip',
  credit_note: 'Credit note',
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EmailHistoryPage() {
  const history = useApiData<EmailHistoryEntry[]>('/api/email-history');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'document' | 'statement'>('all');

  const rows = useMemo(() => {
    const all = history.data ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false;
      if (!q) return true;
      return [e.recipient, e.reference, e.partyName, e.subject]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q));
    });
  }, [history.data, query, kind]);

  const label = (e: EmailHistoryEntry) =>
    e.kind === 'document' ? DOC_LABEL[e.docKind ?? ''] ?? 'Document' : 'Statement';

  return (
    <Page>
      <PageHeader title="Email history">
        Every recorded send — issued documents emailed to customers and statements of account — as one
        chronological log, drawn from the append-only trails the system writes only after the mail relay
        accepts.
      </PageHeader>

      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[12rem]">
            <span className="label">Search</span>
            <input
              className="input w-full"
              placeholder="Recipient, reference, party or subject…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(['all', 'document', 'statement'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`btn btn-sm ${kind === k ? '' : 'btn-ghost'}`}
                onClick={() => setKind(k)}
              >
                {k === 'all' ? 'All' : k === 'document' ? 'Documents' : 'Statements'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {history.loading && !history.data && <p className="mt-4 text-muted text-[0.9rem]">Loading…</p>}
      {history.error && <p className="mt-4 text-bad text-[0.9rem]">{history.error}</p>}

      {history.data && (
        <section className="card mt-4">
          <p className="mb-2 text-muted text-[0.82rem]">
            {rows.length} of {history.data.length} send{history.data.length === 1 ? '' : 's'}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Sent</th>
                <th scope="col">Type</th>
                <th scope="col">Reference</th>
                <th scope="col">Party</th>
                <th scope="col">Recipient</th>
                <th scope="col">Subject</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={i}>
                  <td data-label="Sent" className="mono whitespace-nowrap">{when(e.sentAt)}</td>
                  <td data-label="Type">
                    <span className={`badge ${e.kind === 'statement' ? 'badge-mute' : 'badge-ok'}`}>{label(e)}</span>
                  </td>
                  <td data-label="Reference" className="mono break-words">{e.reference ?? '—'}</td>
                  <td data-label="Party" className="break-words">{e.partyName ?? '—'}</td>
                  <td data-label="Recipient" className="break-words">{e.recipient}</td>
                  <td data-label="Subject" className="text-muted break-words">{e.subject}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td data-label="" colSpan={6} className="py-3 text-center text-muted text-[0.88rem]">
                    {history.data.length === 0 ? 'No emails have been sent yet.' : 'No sends match your search.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </Page>
  );
}

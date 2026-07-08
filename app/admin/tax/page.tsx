'use client';

import { useEffect, useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import type { TaxSettings } from '@/server/settings';

const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function TaxSettingsPage() {
  const { data, error, loading, reload } = useApiData<TaxSettings>('/api/admin/tax');
  const [ppn, setPpn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (data) setPpn(String(data.ppnRate));
  }, [data]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const ppnRate = Number(ppn);
      if (!Number.isFinite(ppnRate)) throw new Error('Enter a valid rate.');
      await api('/api/admin/tax', { method: 'PUT', body: JSON.stringify({ ppnRate }) });
      setMsg({ kind: 'ok', text: 'Rate saved. New invoices will use it.' });
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Tax settings">
        The house VAT/PPN rate, applied to every taxable customer&apos;s invoices. Mark a customer exempt
        (zero-rated, e.g. export) on their own record. Issued invoices keep the rate they were cut with.
      </PageHeader>

      {loading && !data ? (
        <p className={stateBox}>Loading…</p>
      ) : error && !data ? (
        <p className={stateBox}>Could not load — {error}</p>
      ) : (
        <div className="card flex max-w-md flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="label">PPN rate (%)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              className="input w-40"
              value={ppn}
              onChange={(e) => setPpn(e.target.value)}
              disabled={busy}
            />
          </label>
          {msg && (
            <p className={`text-[0.85rem] ${msg.kind === 'ok' ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>
          )}
          <div>
            <button className="btn btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save rate'}
            </button>
          </div>
          {data?.updatedAt && (
            <p className="text-[0.78rem] text-muted">
              Last changed {new Date(data.updatedAt).toLocaleDateString()}.
            </p>
          )}
        </div>
      )}
    </Page>
  );
}

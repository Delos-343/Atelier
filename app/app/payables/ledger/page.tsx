'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { Stat } from '../../../components/Stat';
import { useApiData } from '../../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import { money } from '@/lib/format';
import type { SupplierLedger } from '@/server/payables';

interface Supplier {
  id: string;
  code: string;
  name: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthBounds(year: number, month: number) {
  return { start: iso(new Date(year, month, 1)), end: iso(new Date(year, month + 1, 0)) };
}

const LABEL: Record<string, string> = {
  opening: 'Balance brought forward',
  bill: 'Bill',
  payment: 'Payment',
};

export default function SupplierLedgerPage() {
  const now = new Date();
  const thisMonth = monthBounds(now.getFullYear(), now.getMonth());
  const suppliers = useApiData<Supplier[]>('/api/admin/suppliers');

  const [supplierId, setSupplierId] = useState('');
  const [start, setStart] = useState(thisMonth.start);
  const [end, setEnd] = useState(thisMonth.end);

  const [data, setData] = useState<SupplierLedger | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supplierId) {
      setData(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const d = await api<SupplierLedger>(`/api/payables/ledger/${supplierId}?start=${start}&end=${end}`);
      setData(d);
    } catch (e) {
      setErr(errMsg(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [supplierId, start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  function setMonth(offset: number) {
    const b = monthBounds(now.getFullYear(), now.getMonth() + offset);
    setStart(b.start);
    setEnd(b.end);
  }
  function setQuarter() {
    const qtr = Math.floor(now.getMonth() / 3);
    setStart(iso(new Date(now.getFullYear(), qtr * 3, 1)));
    setEnd(iso(new Date(now.getFullYear(), qtr * 3 + 3, 0)));
  }
  function setYear() {
    setStart(`${now.getFullYear()}-01-01`);
    setEnd(`${now.getFullYear()}-12-31`);
  }

  const pdfHref = supplierId
    ? `/api/payables/ledger/${supplierId}?start=${start}&end=${end}&format=pdf`
    : '#';

  return (
    <Page>
      <PageHeader title="Supplier statement">
        <Link href="/app/payables" className="text-accent hover:underline">
          ← Payables
        </Link>
      </PageHeader>

      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">Supplier</span>
            <select className="input w-64" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select a supplier…</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">From</span>
            <input className="input w-40" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input className="input w-40" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(0)}>
              This month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(-1)}>
              Last month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setQuarter}>
              This quarter
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setYear}>
              This year
            </button>
          </div>
        </div>
        {err && <p className="mt-2 text-[0.85rem] text-bad">{err}</p>}
        {!supplierId && <p className="mt-2 text-muted text-[0.9rem]">Pick a supplier to see their account.</p>}
      </div>

      {supplierId && loading && !data && <p className="mt-4 text-muted text-[0.9rem]">Loading…</p>}

      {data && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="grid grid-cols-2 gap-3 sm:w-96">
              <Stat label="Opening balance" value={money(data.openingBalance)} />
              <Stat label="Balance owed" value={money(data.closingBalance)} />
            </div>
            <a className="btn btn-sm" href={pdfHref} target="_blank" rel="noopener noreferrer">
              Download PDF
            </a>
          </div>

          <section className="card mt-4 overflow-x-auto">
            <div className="w-full overflow-x-auto"><table className="w-full text-[0.9rem] min-w-[44rem]">
              <thead>
                <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
                  <th className="py-1 text-left font-medium">Date</th>
                  <th className="py-1 text-left font-medium">Detail</th>
                  <th className="py-1 text-right font-medium">Bills</th>
                  <th className="py-1 text-right font-medium">Payments</th>
                  <th className="py-1 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e, i) => {
                  const label = LABEL[e.type] ?? e.type;
                  const detail = e.type === 'opening' ? label : e.reference ? `${label} ${e.reference}` : label;
                  return (
                    <tr key={i} className={`border-t border-[var(--border)] ${e.type === 'opening' ? 'text-muted' : ''}`}>
                      <td className="py-1.5">{e.type === 'opening' ? '' : e.date.slice(0, 10)}</td>
                      <td className="py-1.5">{detail}</td>
                      <td className="py-1.5 text-right mono">{e.debit != null ? money(e.debit) : ''}</td>
                      <td className="py-1.5 text-right mono">{e.credit != null ? money(e.credit) : ''}</td>
                      <td className="py-1.5 text-right mono">{money(e.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </section>

          <p className="mt-3 text-[0.82rem] text-muted">
            A running account of what's owed to this supplier: bills raise the balance, payments reduce it, and the
            balance is carried down each line. The balance owed is the amount outstanding at the end of the period.
          </p>
        </>
      )}
    </Page>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { Stat } from '../../components/Stat';
import { StatusBadge, RECEIVABLE_STATUS_TONES, RECEIVABLE_STATUS_LABEL } from '../../components/StatusBadge';
import { useApiData } from '../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import { money } from '@/lib/format';
import type { CustomerReceipt, OpenInvoice, ReceiptAllocation } from '@/server/receipts';

interface Customer {
  id: string;
  code: string;
  name: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Spread an amount across a customer's open invoices. `capAmount` is the ceiling —
 * the receipt amount for a new receipt, or a receipt's unapplied balance when drawing
 * it down later. Anything left under the cap is money on account.
 */
function AllocationEditor({
  invoices,
  capAmount,
  submitLabel,
  onSubmit,
}: {
  invoices: OpenInvoice[];
  capAmount: number;
  submitLabel: string;
  onSubmit: (allocations: ReceiptAllocation[]) => Promise<void>;
}) {
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const allocated = round2(invoices.reduce((s, inv) => s + (Number(alloc[inv.issuedDocumentId]) || 0), 0));
  const remainder = round2(capAmount - allocated);

  function autoApply() {
    let left = round2(capAmount);
    const next: Record<string, string> = {};
    for (const inv of invoices) {
      if (left <= 0) break;
      const take = round2(Math.min(left, inv.open));
      if (take > 0) {
        next[inv.issuedDocumentId] = String(take);
        left = round2(left - take);
      }
    }
    setAlloc(next);
  }

  async function submit() {
    setErr(null);
    const allocations = invoices
      .map((inv) => ({ invoiceId: inv.issuedDocumentId, amount: Number(alloc[inv.issuedDocumentId]) || 0 }))
      .filter((a) => a.amount > 0);
    if (allocations.length === 0) {
      setErr('Enter at least one amount to apply.');
      return;
    }
    if (allocated > capAmount + 1e-6) {
      setErr('That applies more than the amount available.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(allocations);
      setAlloc({});
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (invoices.length === 0) {
    return <p className="text-muted text-[0.9rem]">No open invoices to apply against.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <button type="button" className="btn btn-sm btn-ghost" onClick={autoApply}>
          Auto-apply (oldest first)
        </button>
        <span className="text-[0.85rem] text-muted">
          Applying {money(allocated)} of {money(capAmount)}
          {remainder >= 0 ? ` · ${money(remainder)} on account` : ` · ${money(-remainder)} over`}
        </span>
      </div>
      <div className="w-full overflow-x-auto"><table className="w-full text-[0.9rem] min-w-[34rem]">
        <thead>
          <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
            <th className="py-1 text-left font-medium">Invoice</th>
            <th className="py-1 text-right font-medium">Open</th>
            <th className="py-1 text-right font-medium">Apply</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.issuedDocumentId} className="border-t border-[var(--border)]">
              <td className="py-1.5">
                <span className="mono">{inv.documentNumber}</span>
                {inv.overdue ? <span className="text-bad"> · overdue</span> : null}
              </td>
              <td className="py-1.5 text-right mono">{money(inv.open)}</td>
              <td className="py-1.5 text-right">
                <input
                  className="input w-28 text-right"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={alloc[inv.issuedDocumentId] ?? ''}
                  onChange={(e) => setAlloc((m) => ({ ...m, [inv.issuedDocumentId]: e.target.value }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {err && <p className="mt-2 text-[0.85rem] text-bad">{err}</p>}
      <div className="mt-3">
        <button type="button" className="btn btn-sm" onClick={submit} disabled={busy || remainder < -1e-6}>
          {busy ? 'Working…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

export default function ReceiptsPage() {
  const customers = useApiData<Customer[]>('/api/admin/customers');
  const [customerId, setCustomerId] = useState('');

  const [openInv, setOpenInv] = useState<OpenInvoice[]>([]);
  const [receipts, setReceipts] = useState<CustomerReceipt[]>([]);
  const [onAccount, setOnAccount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [nbErr, setNbErr] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [applyingTo, setApplyingTo] = useState<string | null>(null);

  const load = useCallback(async (cid: string) => {
    if (!cid) {
      setOpenInv([]);
      setReceipts([]);
      setOnAccount(0);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    try {
      const [open, rec] = await Promise.all([
        api<OpenInvoice[]>(`/api/receipts/open?customerId=${cid}`),
        api<{ receipts: CustomerReceipt[]; summary: { onAccount: number; receiptCount: number } }>(
          `/api/receipts?customerId=${cid}`,
        ),
      ]);
      setOpenInv(open);
      setReceipts(rec.receipts);
      setOnAccount(rec.summary.onAccount);
    } catch (e) {
      setLoadErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(customerId);
  }, [customerId, load]);

  const totalOpen = round2(openInv.reduce((s, i) => s + i.open, 0));

  async function recordReceipt(allocations: ReceiptAllocation[]) {
    setNbErr(null);
    const amt = Number(amount);
    if (!(amt > 0)) {
      throw new Error('Enter the amount received.');
    }
    await api('/api/receipts', {
      method: 'POST',
      body: JSON.stringify({ customerId, receiptDate: date, amount: amt, method, reference, allocations }),
    });
    setAmount('');
    setMethod('');
    setReference('');
    await load(customerId);
  }

  async function applyRemaining(receiptId: string, allocations: ReceiptAllocation[]) {
    await api(`/api/receipts/${receiptId}/apply`, { method: 'POST', body: JSON.stringify({ allocations }) });
    setApplyingTo(null);
    await load(customerId);
  }

  async function removeReceipt(receiptId: string) {
    if (!window.confirm('Delete this receipt? Every invoice it settled will reopen.')) return;
    try {
      await api(`/api/receipts/${receiptId}`, { method: 'DELETE' });
      await load(customerId);
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }

  const amountNum = Number(amount) || 0;

  return (
    <Page>
      <PageHeader title="Receipts">
        <span className="text-muted">Apply a customer payment across their open invoices.</span>
      </PageHeader>

      <div className="card">
        <label className="block">
          <span className="label">Customer</span>
          <select
            className="input w-full sm:w-72"
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setExpanded(null);
              setApplyingTo(null);
            }}
          >
            <option value="">Select a customer…</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </label>
        {customers.error && <p className="mt-2 text-[0.85rem] text-bad">{customers.error}</p>}
      </div>

      {customerId && (
        <>
          {loadErr && <p className="mt-4 text-[0.85rem] text-bad">{loadErr}</p>}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Open invoices" value={String(openInv.length)} />
            <Stat label="Total open" value={money(totalOpen)} />
            <Stat label="On account" value={money(onAccount)} />
          </div>

          <section className="card mt-4">
            <h2 className="section-label">New receipt</h2>
            <div className="mt-2 flex flex-wrap gap-3">
              <label className="block">
                <span className="label">Amount received</span>
                <input
                  className="input w-40 text-right"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Date</span>
                <input className="input w-44" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">Method</span>
                <input
                  className="input w-44"
                  placeholder="Bank transfer"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Reference</span>
                <input
                  className="input w-52"
                  placeholder="TRX / cheque no."
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            </div>
            {nbErr && <p className="mt-2 text-[0.85rem] text-bad">{nbErr}</p>}
            <div className="mt-4">
              <AllocationEditor
                invoices={openInv}
                capAmount={amountNum}
                submitLabel="Record receipt"
                onSubmit={recordReceipt}
              />
            </div>
          </section>

          <section className="mt-6">
            <h2 className="section-label">Receipts</h2>
            {loading && receipts.length === 0 ? (
              <p className="mt-2 text-muted text-[0.9rem]">Loading…</p>
            ) : receipts.length === 0 ? (
              <p className="mt-2 text-muted text-[0.9rem]">No receipts recorded for this customer yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {receipts.map((r) => (
                  <div key={r.id} className="card">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="mono">{r.receiptDate}</span>
                        <span className="mono font-semibold">{money(r.amount)}</span>
                        {r.unapplied > 0 ? (
                          <span className="badge badge-warn">{money(r.unapplied)} on account</span>
                        ) : (
                          <span className="badge badge-ok">fully applied</span>
                        )}
                        {r.method && <span className="text-muted text-[0.85rem]">{r.method}</span>}
                        {r.reference && <span className="text-muted text-[0.85rem]">· {r.reference}</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {r.applicationCount > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          >
                            {expanded === r.id ? 'Hide' : `${r.applicationCount} applied`}
                          </button>
                        )}
                        {r.unapplied > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setApplyingTo(applyingTo === r.id ? null : r.id)}
                          >
                            {applyingTo === r.id ? 'Cancel' : 'Apply remaining'}
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-bad" onClick={() => removeReceipt(r.id)}>
                          Delete
                        </button>
                      </div>
                    </div>

                    {expanded === r.id && r.applications.length > 0 && (
                      <div className="w-full overflow-x-auto"><table className="mt-3 w-full text-[0.9rem] min-w-[34rem]">
                        <tbody>
                          {r.applications.map((a) => (
                            <tr key={a.id} className="border-t border-[var(--border)]">
                              <td className="py-1.5">
                                <span className="mono">{a.documentNumber}</span>
                              </td>
                              <td className="py-1.5 text-muted">{a.paidDate}</td>
                              <td className="py-1.5 text-right mono">{money(a.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                    )}

                    {applyingTo === r.id && (
                      <div className="mt-3 border-t border-[var(--border)] pt-3">
                        <AllocationEditor
                          invoices={openInv}
                          capAmount={r.unapplied}
                          submitLabel="Apply"
                          onSubmit={(allocs) => applyRemaining(r.id, allocs)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

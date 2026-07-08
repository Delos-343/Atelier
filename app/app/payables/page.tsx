'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { DataTable, type Column } from '../../components/DataTable';
import { useRole } from '../../components/auth/SessionProvider';
import { Stat } from '../../components/Stat';
import { StatusBadge, RECEIVABLE_STATUS_TONES, RECEIVABLE_STATUS_LABEL } from '../../components/StatusBadge';
import { api, errMsg } from '@/lib/api-client';
import { money } from '@/lib/format';
import type { BillSummary } from '@/server/payables';
import type { PurchaseOrderException } from '@/server/procurement';

interface Supplier {
  id: string;
  code: string;
  name: string;
}

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

const billColumns = (handlers: {
  onPay: (b: BillSummary) => void;
  onVoid: (b: BillSummary) => void;
}): Column<BillSummary>[] => [
  {
    key: 'number',
    header: 'Bill',
    render: (b) => (
      <span className="flex items-center gap-2">
        <span
          className={`mono ${b.voided ? 'text-muted line-through' : ''}`}
          title={b.voided ? b.voidReason ?? undefined : undefined}
        >
          {b.billNumber}
        </span>
        {b.voided && <span className="badge badge-mute">void</span>}
      </span>
    ),
  },
  { key: 'supplier', header: 'Supplier', render: (b) => b.supplierName },
  { key: 'billed', header: 'Billed', render: (b) => <span className="mono">{b.billDate.slice(0, 10)}</span> },
  {
    key: 'due',
    header: 'Due',
    render: (b) =>
      b.dueDate == null ? (
        <span className="text-muted">—</span>
      ) : (
        <span className={`mono ${b.overdue ? 'text-bad' : 'text-muted'}`}>{b.dueDate.slice(0, 10)}</span>
      ),
  },
  { key: 'amount', header: 'Amount', align: 'right', render: (b) => <span className="mono">{money(b.amount)}</span> },
  { key: 'paid', header: 'Paid', align: 'right', render: (b) => <span className="mono">{money(b.paid)}</span> },
  {
    key: 'open',
    header: 'Balance',
    align: 'right',
    render: (b) => (
      <span className={`mono ${b.voided ? 'text-muted' : b.open > 0 ? '' : 'text-ok'}`}>
        {b.voided ? '—' : money(b.open)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (b) => (
      <span className="flex items-center gap-2">
        <StatusBadge value={b.status} tones={RECEIVABLE_STATUS_TONES}>
          {RECEIVABLE_STATUS_LABEL[b.status] ?? b.status}
        </StatusBadge>
        {b.overdue && <span className="badge badge-bad">overdue</span>}
      </span>
    ),
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: (b) => (
      <span className="flex items-center justify-end gap-3">
        {!b.voided && b.open > 0 && (
          <button type="button" className="text-accent underline" onClick={() => handlers.onPay(b)}>
            Pay…
          </button>
        )}
        {!b.voided && (
          <button type="button" className="text-bad underline" onClick={() => handlers.onVoid(b)}>
            Void…
          </button>
        )}
      </span>
    ),
  },
];

export default function PayablesPage() {
  const role = useRole();
  const bills = useApiData<BillSummary[]>('/api/bills');
  const suppliersData = useApiData<Supplier[]>('/api/admin/suppliers');
  const exceptions = useApiData<PurchaseOrderException[]>('/api/purchase-orders/exceptions');

  const [showNew, setShowNew] = useState(false);
  const [nbSupplier, setNbSupplier] = useState('');
  const [nbNumber, setNbNumber] = useState('');
  const [nbDate, setNbDate] = useState(new Date().toISOString().slice(0, 10));
  const [nbAmount, setNbAmount] = useState('');
  const [nbTax, setNbTax] = useState('');
  const [nbDue, setNbDue] = useState('');
  const [nbDesc, setNbDesc] = useState('');
  const [nbSaving, setNbSaving] = useState(false);
  const [nbErr, setNbErr] = useState<string | null>(null);

  const [payId, setPayId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [payReference, setPayReference] = useState('');
  const [paySaving, setPaySaving] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);

  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidSaving, setVoidSaving] = useState(false);
  const [voidErr, setVoidErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (role && role !== 'admin') {
    return (
      <Page>
        <PageHeader title="Payables">Money owed to suppliers.</PageHeader>
        <p className={STATE}>Payables is visible to administrators only.</p>
      </Page>
    );
  }

  const rows = bills.data ?? [];
  const suppliers = suppliersData.data ?? [];
  const payBill = payId ? rows.find((b) => b.id === payId) ?? null : null;
  const voidBill = voidId ? rows.find((b) => b.id === voidId) ?? null : null;

  const live = rows.filter((b) => b.status === 'open' || b.status === 'partially_paid');
  const outstanding = live.reduce((s, b) => s + b.open, 0);
  const paidOut = rows.filter((b) => b.status !== 'void').reduce((s, b) => s + b.paid, 0);
  const overdueCount = rows.filter((b) => b.overdue).length;

  async function createBill() {
    setNbSaving(true);
    setNbErr(null);
    try {
      await api('/api/bills', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: nbSupplier,
          billNumber: nbNumber,
          billDate: nbDate,
          amount: Number(nbAmount),
          ...(nbTax.trim() ? { taxAmount: Number(nbTax) } : {}),
          dueDate: nbDue || undefined,
          description: nbDesc || undefined,
        }),
      });
      setNote(`Bill ${nbNumber} entered.`);
      setNbNumber('');
      setNbAmount('');
      setNbTax('');
      setNbDue('');
      setNbDesc('');
      setShowNew(false);
      bills.reload();
    } catch (e) {
      setNbErr(errMsg(e));
    } finally {
      setNbSaving(false);
    }
  }

  function openPay(b: BillSummary) {
    setVoidId(null);
    setNote(null);
    setPayId(b.id);
    setPayAmount(b.open > 0 ? String(b.open) : '');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMethod('');
    setPayReference('');
    setPayErr(null);
  }

  async function savePayment() {
    if (!payBill) return;
    setPaySaving(true);
    setPayErr(null);
    try {
      await api(`/api/bills/${payBill.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(payAmount),
          paidDate: payDate,
          method: payMethod,
          reference: payReference,
        }),
      });
      setNote(`Payment recorded against ${payBill.billNumber}.`);
      setPayAmount('');
      setPayMethod('');
      setPayReference('');
      bills.reload();
    } catch (e) {
      setPayErr(errMsg(e));
    } finally {
      setPaySaving(false);
    }
  }

  async function deletePayment(paymentId: string) {
    if (!window.confirm('Delete this payment? The bill balance will reopen by that amount.')) return;
    setPaySaving(true);
    setPayErr(null);
    try {
      await api(`/api/bill-payments/${paymentId}`, { method: 'DELETE' });
      setNote('Payment deleted; the balance has reopened.');
      bills.reload();
    } catch (e) {
      setPayErr(errMsg(e));
    } finally {
      setPaySaving(false);
    }
  }

  function openVoid(b: BillSummary) {
    setPayId(null);
    setNote(null);
    setVoidId(b.id);
    setVoidReason('');
    setVoidErr(null);
  }

  async function saveVoid() {
    if (!voidBill) return;
    setVoidSaving(true);
    setVoidErr(null);
    try {
      await api(`/api/bills/${voidBill.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setNote(`Bill ${voidBill.billNumber} voided.`);
      setVoidId(null);
      bills.reload();
    } catch (e) {
      setVoidErr(errMsg(e));
    } finally {
      setVoidSaving(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Payables">
        Bills owed to suppliers — what&apos;s outstanding, what&apos;s been paid, and what&apos;s overdue,
        all from the single AP derivation that mirrors receivables.{' '}
        <Link href="/app/payables/aging" className="text-accent hover:underline">
          Aging report →
        </Link>{' '}
        <Link href="/app/payables/ledger" className="text-accent hover:underline">
          Supplier statement →
        </Link>
      </PageHeader>

      <div className="mb-6 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
        <Stat label="Outstanding" value={money(outstanding)} sub={`${live.length} open`} />
        <Stat label="Paid out" value={money(paidOut)} />
        <Stat label="Overdue" value={String(overdueCount)} />
      </div>

      {(exceptions.data?.length ?? 0) > 0 && (
        <div className="mb-6 rounded border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="section-label text-bad">Billing exceptions ({exceptions.data!.length})</h2>
            <Link href="/app/procurement" className="text-accent hover:underline text-[0.85rem]">
              Review in procurement →
            </Link>
          </div>
          <p className="mt-1 text-[0.82rem] text-muted">
            These purchase orders are billed out of line with the goods received — worth resolving before
            the bill is paid.
          </p>
          <ul className="mt-2 space-y-1 text-[0.88rem]">
            {exceptions.data!.map((po) => (
              <li key={po.id} className="flex flex-wrap items-center gap-2">
                <span className="mono font-semibold">{po.code}</span>
                <span className="text-muted">{po.supplierName}</span>
                <span className={`badge ${po.matchStatus === 'over_billed' ? 'badge-bad' : 'badge-warn'}`}>
                  {po.matchStatus === 'over_billed' ? 'over-billed' : 'under-billed'}
                </span>
                <span className={`mono ${po.matchStatus === 'over_billed' ? 'text-bad' : 'text-muted'}`}>
                  {po.variance > 0 ? '+' : ''}
                  {money(po.variance)}
                </span>
                <span className="text-muted text-[0.8rem]">
                  billed {money(po.billedNet)} vs received {money(po.receivedValue)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Close' : 'New bill'}
        </button>
        {note && <span className="text-[0.85rem] text-ok">{note}</span>}
      </div>

      {showNew && (
        <div className="card mb-6 flex flex-col gap-3">
          <div className="section-label">Enter a bill</div>
          {suppliers.length === 0 ? (
            <p className="text-[0.85rem] text-muted">
              No suppliers yet — add one under{' '}
              <Link href="/admin/suppliers" className="text-accent underline">
                Admin → Suppliers
              </Link>{' '}
              first.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="label">Supplier</span>
                  <select
                    className="input w-60"
                    value={nbSupplier}
                    onChange={(e) => setNbSupplier(e.target.value)}
                    disabled={nbSaving}
                  >
                    <option value="">Select a supplier…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} · {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Bill number</span>
                  <input
                    className="input w-44"
                    value={nbNumber}
                    onChange={(e) => setNbNumber(e.target.value)}
                    placeholder="supplier's ref"
                    disabled={nbSaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Bill date</span>
                  <input
                    type="date"
                    className="input w-44"
                    value={nbDate}
                    onChange={(e) => setNbDate(e.target.value)}
                    disabled={nbSaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Amount</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input w-36"
                    value={nbAmount}
                    onChange={(e) => setNbAmount(e.target.value)}
                    disabled={nbSaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">of which PPN</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input w-32"
                    value={nbTax}
                    onChange={(e) => setNbTax(e.target.value)}
                    placeholder="0.00"
                    disabled={nbSaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Due date</span>
                  <input
                    type="date"
                    className="input w-44"
                    value={nbDue}
                    onChange={(e) => setNbDue(e.target.value)}
                    disabled={nbSaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Description</span>
                  <input
                    className="input w-52"
                    value={nbDesc}
                    onChange={(e) => setNbDesc(e.target.value)}
                    placeholder="optional"
                    disabled={nbSaving}
                  />
                </label>
              </div>
              {nbErr && <p className="text-[0.85rem] text-bad">{nbErr}</p>}
              <div className="flex flex-wrap gap-2.5">
                <button
                  className="btn btn-sm"
                  onClick={createBill}
                  disabled={nbSaving || !nbSupplier || !nbNumber || !nbAmount}
                >
                  {nbSaving ? 'Saving…' : 'Enter bill'}
                </button>
              </div>
              <p className="text-[0.78rem] text-muted">
                Leave the due date blank to derive it from the supplier&apos;s payment terms.
              </p>
            </>
          )}
        </div>
      )}

      {bills.loading && !bills.data ? (
        <p className={STATE}>Loading…</p>
      ) : bills.error && !bills.data ? (
        <p className={STATE}>Could not load — {bills.error}</p>
      ) : rows.length === 0 ? (
        <p className={STATE}>No bills entered yet.</p>
      ) : (
        <DataTable columns={billColumns({ onPay: openPay, onVoid: openVoid })} rows={rows} rowKey={(b) => b.id} />
      )}

      {payBill && (
        <div className="card mt-3 flex flex-col gap-3">
          <div className="section-label">Payments · bill {payBill.billNumber}</div>
          <p className="text-[0.82rem] text-muted">
            Amount {money(payBill.amount)} · paid {money(payBill.paid)} ·{' '}
            <span className={payBill.open > 0 ? 'text-text' : 'text-ok'}>
              {payBill.open > 0 ? `${money(payBill.open)} open` : 'fully paid'}
            </span>
          </p>
          {payBill.payments.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {payBill.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 border-b border-border pb-1.5 text-[0.85rem] last:border-0 last:pb-0"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="mono">{p.paidDate}</span>
                    <span className="mono">{money(p.amount)}</span>
                    {p.method && <span className="text-muted">{p.method}</span>}
                    {p.reference && <span className="text-muted">· {p.reference}</span>}
                  </span>
                  <button
                    type="button"
                    className="text-bad underline disabled:opacity-50"
                    onClick={() => deletePayment(p.id)}
                    disabled={paySaving}
                    title="Delete this payment"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          {payBill.open > 0 ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="label">Amount</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="input w-36"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    disabled={paySaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Date</span>
                  <input
                    type="date"
                    className="input w-44"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    disabled={paySaving}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Method</span>
                  <input
                    className="input w-44"
                    list="bill-pay-methods"
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                    placeholder="bank transfer"
                    disabled={paySaving}
                  />
                  <datalist id="bill-pay-methods">
                    <option value="Bank transfer" />
                    <option value="QRIS" />
                    <option value="Cash" />
                    <option value="Cheque" />
                    <option value="Card" />
                  </datalist>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Reference</span>
                  <input
                    className="input w-52"
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    placeholder="optional"
                    disabled={paySaving}
                  />
                </label>
              </div>
              {payErr && <p className="text-[0.85rem] text-bad">{payErr}</p>}
              <div className="flex flex-wrap gap-2.5">
                <button className="btn btn-sm" onClick={savePayment} disabled={paySaving}>
                  {paySaving ? 'Saving…' : 'Record payment'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setPayId(null)} disabled={paySaving}>
                  Close
                </button>
              </div>
              <p className="text-[0.78rem] text-muted">
                A payment can&apos;t exceed the open balance, and is recorded to 2 decimal places. Correct a
                mistaken entry with Delete — the balance reopens.
              </p>
            </>
          ) : (
            <>
              {payErr && <p className="text-[0.85rem] text-bad">{payErr}</p>}
              <div className="flex flex-wrap gap-2.5">
                <button className="btn btn-sm btn-ghost" onClick={() => setPayId(null)} disabled={paySaving}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {voidBill && (
        <div className="card mt-3 flex flex-col gap-3">
          <div className="section-label">Void bill {voidBill.billNumber}</div>
          <p className="text-[0.82rem] text-muted">
            Voiding removes this bill from payables. Its record and any payments remain for the trail.
          </p>
          <label className="flex flex-col gap-1">
            <span className="label">Reason</span>
            <input
              className="input w-full max-w-md"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. duplicate of BILL-123"
              disabled={voidSaving}
            />
          </label>
          {voidErr && <p className="text-[0.85rem] text-bad">{voidErr}</p>}
          <div className="flex flex-wrap gap-2.5">
            <button
              className="btn btn-sm btn-bad"
              onClick={saveVoid}
              disabled={voidSaving || voidReason.trim() === ''}
            >
              {voidSaving ? 'Voiding…' : 'Void bill'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setVoidId(null)} disabled={voidSaving}>
              Close
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}

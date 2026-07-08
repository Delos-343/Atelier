'use client';

import { useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { useApiData } from '../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import { money } from '@/lib/format';
import type { PurchaseOrderSummary, PurchaseOrderLine } from '@/server/procurement';

interface Supplier {
  id: string;
  code: string;
  name: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
}
interface Material {
  id: string;
  sku: string;
  name: string;
  base_unit: string;
}

const PO_TONES: Record<string, BadgeTone> = {
  open: 'warn',
  partially_received: 'warn',
  received: 'ok',
  cancelled: 'mute',
};
const PO_LABEL: Record<string, string> = {
  open: 'open',
  partially_received: 'partially received',
  received: 'received',
  cancelled: 'cancelled',
};
const MATCH_TONES: Record<string, BadgeTone> = {
  matched: 'ok',
  over_billed: 'bad',
  under_billed: 'warn',
  unbilled: 'mute',
};
const MATCH_LABEL: Record<string, string> = {
  matched: 'matched',
  over_billed: 'over-billed',
  under_billed: 'under-billed',
  unbilled: 'unbilled',
};
const UNITS = ['kg', 'g', 'mg', 'l', 'ml'];
const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

interface DraftLine {
  key: number;
  rawMaterialId: string;
  quantity: string;
  unit: string;
  unitCost: string;
}

let nextKey = 1;
const blankLine = (): DraftLine => ({ key: nextKey++, rawMaterialId: '', quantity: '', unit: 'g', unitCost: '' });

// ── receive a purchase order ────────────────────────────────────────────────────
function ReceivePanel({ po, onDone }: { po: PurchaseOrderSummary; onDone: () => void }) {
  const outstanding = po.lines.filter((l) => l.receivedQuantity < l.quantity);
  const [rows, setRows] = useState<Record<string, { qty: string; lot: string; expiry: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set(lineId: string, field: 'qty' | 'lot' | 'expiry', v: string) {
    setRows((m) => {
      const cur = m[lineId] ?? { qty: '', lot: '', expiry: '' };
      return { ...m, [lineId]: { ...cur, [field]: v } };
    });
  }

  async function submit() {
    setErr(null);
    const receipts = outstanding
      .map((l) => {
        const r = rows[l.id];
        const q = Number(r?.qty) || 0;
        return q > 0 ? { lineId: l.id, quantity: q, lotCode: (r?.lot ?? '').trim(), expiryDate: r?.expiry || null } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (receipts.length === 0) {
      setErr('Enter a quantity on at least one line.');
      return;
    }
    if (receipts.some((r) => !r.lotCode)) {
      setErr('Each received line needs a lot code.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/purchase-orders/${po.id}/receive`, { method: 'POST', body: JSON.stringify({ receipts }) });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <h3 className="section-label">Receive stock</h3>
      <table className="mt-2 w-full text-[0.9rem]">
        <thead>
          <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
            <th className="py-1 text-left font-medium">Material</th>
            <th className="py-1 text-right font-medium">Outstanding</th>
            <th className="py-1 text-right font-medium">Receive</th>
            <th className="py-1 text-left font-medium">Lot code</th>
            <th className="py-1 text-left font-medium">Expiry</th>
          </tr>
        </thead>
        <tbody>
          {outstanding.map((l) => {
            const rem = round2(l.quantity - l.receivedQuantity);
            return (
              <tr key={l.id} className="border-t border-[var(--border)]">
                <td className="py-1.5">
                  <span className="mono">{l.sku}</span> {l.name}
                </td>
                <td className="py-1.5 text-right mono">
                  {rem} {l.unit}
                </td>
                <td className="py-1.5 text-right">
                  <input
                    className="input w-24 text-right"
                    inputMode="decimal"
                    placeholder={String(rem)}
                    value={rows[l.id]?.qty ?? ''}
                    onChange={(e) => set(l.id, 'qty', e.target.value)}
                  />
                </td>
                <td className="py-1.5">
                  <input
                    className="input w-36"
                    placeholder="supplier batch"
                    value={rows[l.id]?.lot ?? ''}
                    onChange={(e) => set(l.id, 'lot', e.target.value)}
                  />
                </td>
                <td className="py-1.5">
                  <input
                    className="input w-40"
                    type="date"
                    value={rows[l.id]?.expiry ?? ''}
                    onChange={(e) => set(l.id, 'expiry', e.target.value)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {err && <p className="mt-2 text-[0.85rem] text-bad">{err}</p>}
      <div className="mt-3">
        <button type="button" className="btn btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'Receiving…' : 'Receive'}
        </button>
      </div>
    </div>
  );
}

// ── bill a purchase order ───────────────────────────────────────────────────────
function BillPanel({ po, onDone }: { po: PurchaseOrderSummary; onDone: () => void }) {
  const [billNumber, setBillNumber] = useState('');
  const [billDate, setBillDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!billNumber.trim()) {
      setErr('Enter the supplier bill number.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/purchase-orders/${po.id}/bill`, {
        method: 'POST',
        body: JSON.stringify({
          billNumber: billNumber.trim(),
          billDate,
          ...(amount.trim() ? { amount: Number(amount) } : {}),
          ...(tax.trim() ? { taxAmount: Number(tax) } : {}),
        }),
      });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <h3 className="section-label">Bill this order</h3>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Supplier bill no.</span>
          <input className="input w-44" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Bill date</span>
          <input className="input w-40" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Amount</span>
          <input
            className="input w-36 text-right"
            inputMode="decimal"
            placeholder={money(po.receivedValue || po.orderedValue)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">of which PPN</span>
          <input
            className="input w-32 text-right"
            inputMode="decimal"
            placeholder="0.00"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
          />
        </label>
        <button type="button" className="btn btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'Billing…' : 'Create bill'}
        </button>
      </div>
      <p className="mt-1 text-[0.8rem] text-muted">Leave the amount blank to bill the received value. PPN feeds the tax report.</p>
      {err && <p className="mt-2 text-[0.85rem] text-bad">{err}</p>}
    </div>
  );
}

export default function ProcurementPage() {
  const orders = useApiData<PurchaseOrderSummary[]>('/api/purchase-orders');
  const suppliers = useApiData<Supplier[]>('/api/admin/suppliers');
  const warehouses = useApiData<Warehouse[]>('/api/admin/warehouses');
  const materials = useApiData<Material[]>('/api/admin/materials');

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [code, setCode] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [nbErr, setNbErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ id: string; kind: 'receive' | 'bill' } | null>(null);
  const [matchFilter, setMatchFilter] = useState<'all' | 'exceptions'>('all');

  const isException = (s: string) => s === 'over_billed' || s === 'under_billed';
  const exceptionCount = (orders.data ?? []).filter((po) => isException(po.matchStatus)).length;
  const visibleOrders = (orders.data ?? []).filter((po) => matchFilter === 'all' || isException(po.matchStatus));

  const matById = new Map((materials.data ?? []).map((m) => [m.id, m]));

  function setLine(key: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function createPO() {
    setNbErr(null);
    const payload = lines
      .filter((l) => l.rawMaterialId && Number(l.quantity) > 0)
      .map((l) => ({
        rawMaterialId: l.rawMaterialId,
        quantity: Number(l.quantity),
        unit: l.unit,
        unitCost: Number(l.unitCost) || 0,
      }));
    if (!supplierId || !warehouseId) {
      setNbErr('Pick a supplier and a warehouse.');
      return;
    }
    if (payload.length === 0) {
      setNbErr('Add at least one line with a material and quantity.');
      return;
    }
    setSaving(true);
    try {
      await api('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), supplierId, warehouseId, orderDate, lines: payload }),
      });
      setCode('');
      setLines([blankLine()]);
      orders.reload();
    } catch (e) {
      setNbErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function cancelPO(id: string) {
    if (!window.confirm('Cancel this purchase order?')) return;
    try {
      await api(`/api/purchase-orders/${id}/cancel`, { method: 'POST', body: '{}' });
      orders.reload();
    } catch (e) {
      window.alert(errMsg(e));
    }
  }

  function afterMutation() {
    setPanel(null);
    orders.reload();
  }

  return (
    <Page>
      <PageHeader title="Procurement">
        <span className="text-muted">Raise purchase orders, receive stock into inventory, and bill suppliers.</span>
      </PageHeader>

      <section className="card">
        <h2 className="section-label">New purchase order</h2>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">Code</span>
            <input className="input w-40" placeholder="PO-2026-001" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Supplier</span>
            <select className="input w-56" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select a supplier…</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Warehouse</span>
            <select className="input w-48" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Order date</span>
            <input className="input w-40" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </label>
        </div>

        <table className="mt-4 w-full text-[0.9rem]">
          <thead>
            <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
              <th className="py-1 text-left font-medium">Material</th>
              <th className="py-1 text-right font-medium">Quantity</th>
              <th className="py-1 text-left font-medium">Unit</th>
              <th className="py-1 text-right font-medium">Unit cost</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="border-t border-[var(--border)]">
                <td className="py-1.5">
                  <select
                    className="input w-56"
                    value={l.rawMaterialId}
                    onChange={(e) => {
                      const m = matById.get(e.target.value);
                      setLine(l.key, { rawMaterialId: e.target.value, unit: m?.base_unit ?? l.unit });
                    }}
                  >
                    <option value="">Select a material…</option>
                    {(materials.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.sku} — {m.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 text-right">
                  <input
                    className="input w-24 text-right"
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                  />
                </td>
                <td className="py-1.5">
                  <select className="input w-20" value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}>
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 text-right">
                  <input
                    className="input w-28 text-right"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={l.unitCost}
                    onChange={(e) => setLine(l.key, { unitCost: e.target.value })}
                  />
                </td>
                <td className="py-1.5 text-right">
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            Add line
          </button>
        </div>

        {nbErr && <p className="mt-3 text-[0.85rem] text-bad">{nbErr}</p>}
        <div className="mt-3">
          <button type="button" className="btn" onClick={createPO} disabled={saving}>
            {saving ? 'Raising…' : 'Raise purchase order'}
          </button>
        </div>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-label">Purchase orders</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${matchFilter === 'all' ? '' : 'btn-ghost'}`}
              onClick={() => setMatchFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`btn btn-sm ${matchFilter === 'exceptions' ? '' : 'btn-ghost'}`}
              onClick={() => setMatchFilter('exceptions')}
              disabled={exceptionCount === 0}
              title={exceptionCount === 0 ? 'No billing exceptions' : undefined}
            >
              Exceptions{exceptionCount > 0 ? ` (${exceptionCount})` : ''}
            </button>
          </div>
        </div>
        {orders.error ? (
          <p className="mt-2 text-[0.85rem] text-bad">{orders.error}</p>
        ) : orders.loading && !orders.data ? (
          <p className="mt-2 text-muted text-[0.9rem]">Loading…</p>
        ) : visibleOrders.length === 0 ? (
          <p className="mt-2 text-muted text-[0.9rem]">
            {(orders.data ?? []).length === 0
              ? 'No purchase orders yet.'
              : 'No billing exceptions — every billed order ties out to what was received.'}
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {visibleOrders.map((po) => (
              <div key={po.id} className="card">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="mono font-semibold">{po.code}</span>
                    <StatusBadge value={po.status} tones={PO_TONES}>
                      {PO_LABEL[po.status] ?? po.status}
                    </StatusBadge>
                    <span className="text-muted text-[0.85rem]">{po.supplierName}</span>
                    <span className="text-muted text-[0.85rem]">· {po.warehouseName}</span>
                  </div>
                  <div className="flex items-center gap-4 text-[0.85rem]">
                    <span>
                      <span className="text-muted">ordered </span>
                      <span className="mono">{money(po.orderedValue)}</span>
                    </span>
                    <span>
                      <span className="text-muted">received </span>
                      <span className="mono">{money(po.receivedValue)}</span>
                    </span>
                    <span>
                      <span className="text-muted">billed </span>
                      <span className="mono">{money(po.billed)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusBadge value={po.matchStatus} tones={MATCH_TONES}>
                        {MATCH_LABEL[po.matchStatus] ?? po.matchStatus}
                      </StatusBadge>
                      {(po.matchStatus === 'over_billed' || po.matchStatus === 'under_billed') && (
                        <span className={`mono ${po.matchStatus === 'over_billed' ? 'text-bad' : 'text-muted'}`}>
                          {po.variance > 0 ? '+' : ''}
                          {money(po.variance)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setExpanded(expanded === po.id ? null : po.id)}
                  >
                    {expanded === po.id ? 'Hide lines' : `${po.lineCount} lines`}
                  </button>
                  {(po.status === 'open' || po.status === 'partially_received') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPanel(panel?.id === po.id && panel.kind === 'receive' ? null : { id: po.id, kind: 'receive' })}
                    >
                      Receive
                    </button>
                  )}
                  {po.status !== 'cancelled' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setPanel(panel?.id === po.id && panel.kind === 'bill' ? null : { id: po.id, kind: 'bill' })}
                    >
                      Bill
                    </button>
                  )}
                  {po.status === 'open' && (
                    <button type="button" className="btn btn-sm btn-bad" onClick={() => cancelPO(po.id)}>
                      Cancel
                    </button>
                  )}
                </div>

                {expanded === po.id && (
                  <table className="mt-3 w-full text-[0.9rem]">
                    <thead>
                      <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
                        <th className="py-1 text-left font-medium">Material</th>
                        <th className="py-1 text-right font-medium">Ordered</th>
                        <th className="py-1 text-right font-medium">Received</th>
                        <th className="py-1 text-right font-medium">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.lines.map((l: PurchaseOrderLine) => (
                        <tr key={l.id} className="border-t border-[var(--border)]">
                          <td className="py-1.5">
                            <span className="mono">{l.sku}</span> {l.name}
                          </td>
                          <td className="py-1.5 text-right mono">
                            {l.quantity} {l.unit}
                          </td>
                          <td className="py-1.5 text-right mono">
                            {l.receivedQuantity} {l.unit}
                          </td>
                          <td className="py-1.5 text-right mono">{money(l.unitCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {panel?.id === po.id && panel.kind === 'receive' && <ReceivePanel po={po} onDone={afterMutation} />}
                {panel?.id === po.id && panel.kind === 'bill' && <BillPanel po={po} onDone={afterMutation} />}
              </div>
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}

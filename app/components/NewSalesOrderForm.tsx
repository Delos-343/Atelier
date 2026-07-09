'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';

type Unit = 'kg' | 'g' | 'mg' | 'l' | 'ml';
const UNITS: Unit[] = ['kg', 'g', 'mg', 'l', 'ml'];

interface CustomerOpt { id: string; code: string; name: string }
interface WarehouseOpt { id: string; code: string; name: string }
interface ProductOpt { id: string; sku: string; name: string; base_unit: Unit }

interface Line { productId: string; quantity: string; unit: Unit; unitPrice: string }

const emptyLine = (): Line => ({ productId: '', quantity: '', unit: 'l', unitPrice: '' });
const GRID = 'grid gap-[0.9rem] [grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))]';
const today = () => new Date().toISOString().slice(0, 10);

export function NewSalesOrderForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [customers, setCustomers] = useState<CustomerOpt[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseOpt[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [code, setCode] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [orderDate, setOrderDate] = useState(today());
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [c, w, p] = await Promise.all([
          api<CustomerOpt[]>('/api/admin/customers'),
          api<WarehouseOpt[]>('/api/admin/warehouses'),
          api<ProductOpt[]>('/api/admin/products'),
        ]);
        setCustomers(c);
        setWarehouses(w);
        setProducts(p);
      } catch (e) {
        setMsg({ kind: 'err', text: errMsg(e) });
      }
    })();
  }, []);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  // When a product is chosen, default the line's unit to that product's base unit.
  const pickProduct = (i: number, productId: string) => {
    const prod = products.find((p) => p.id === productId);
    setLine(i, { productId, ...(prod ? { unit: prod.base_unit } : {}) });
  };

  function reset() {
    setCode('');
    setCustomerId('');
    setWarehouseId('');
    setOrderDate(today());
    setLines([emptyLine()]);
  }

  const linesValid = lines.every((l) => l.productId && Number(l.quantity) > 0);
  const canSubmit = !!code && !!customerId && !!warehouseId && linesValid;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          code,
          customerId,
          warehouseId,
          orderDate,
          lines: lines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            unit: l.unit,
            unitPrice: l.unitPrice === '' ? 0 : Number(l.unitPrice),
          })),
        }),
      });
      setMsg({ kind: 'ok', text: 'Sales order created.' });
      reset();
      onSubmitted?.();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mb-5">
      <h2 className="mb-4 text-[1.05rem] font-semibold tracking-[-0.01em]">New sales order</h2>

      <div className={GRID}>
        <label className="flex flex-col gap-1.5">
          <span className="label">Order code</span>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="SO-2026-001" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Customer</span>
          <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Fulfilling warehouse</span>
          <select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Select…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label">Order date</span>
          <input type="date" className="input" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </label>
      </div>

      <h3 className="section-label mb-2 mt-6">Lines</h3>
      <div className="flex flex-col gap-2.5">
        {lines.map((l, i) => (
          <div key={i} className="grid items-end gap-2 gap-y-3 [grid-template-columns:repeat(2,minmax(0,1fr))] sm:gap-y-2 sm:[grid-template-columns:2fr_1fr_0.8fr_1fr_auto]">
            <label className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <span className={`label ${i === 0 ? '' : 'sm:hidden'}`}>Product</span>
              <select className="input" value={l.productId} onChange={(e) => pickProduct(i, e.target.value)}>
                <option value="">Select…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={`label ${i === 0 ? '' : 'sm:hidden'}`}>Quantity</span>
              <input className="input" inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={`label ${i === 0 ? '' : 'sm:hidden'}`}>Unit</span>
              <select className="input" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value as Unit })}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
              <span className={`label ${i === 0 ? '' : 'sm:hidden'}`}>Unit price</span>
              <input className="input" inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} placeholder="0" />
            </label>
            <button
              type="button"
              className="icon-btn mb-0.5 col-span-2 justify-self-end sm:col-span-1 sm:justify-self-auto"
              aria-label="Remove line"
              onClick={() => removeLine(i)}
              disabled={lines.length === 1}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost btn-sm mt-2.5" onClick={addLine}>+ Add line</button>

      {msg && <p className={`mt-3 text-[0.85rem] ${msg.kind === 'ok' ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      <div className="mt-[1.1rem] flex flex-wrap gap-2.5">
        <button className="btn" onClick={submit} disabled={busy || !canSubmit}>
          {busy ? 'Creating…' : 'Create order'}
        </button>
      </div>
    </div>
  );
}

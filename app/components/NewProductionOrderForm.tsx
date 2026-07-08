'use client';

import { useState } from 'react';
import { useOffline } from './offline/OfflineProvider';
import { DataTable, type Column } from './DataTable';
import type { HalalVerdict } from '@/server/compliance';

type Unit = 'kg' | 'g' | 'mg' | 'l' | 'ml';

interface PlannedComponent {
  rawMaterialId: string;
  sku: string;
  name: string;
  quantity: string;
  unit: Unit;
}

const EMPTY = {
  code: '',
  productId: '',
  formulaVersionId: '',
  warehouseId: '',
  plannedQuantity: '',
  unit: 'g' as Unit,
};

const GRID = 'grid gap-[0.9rem] [grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))]';

const previewColumns: Column<PlannedComponent>[] = [
  {
    key: 'material',
    header: 'Material',
    render: (p) => (
      <>
        <span className="mono">{p.sku}</span>
        {p.name ? <span className="text-muted"> · {p.name}</span> : null}
      </>
    ),
  },
  { key: 'required', header: 'Required', align: 'right', render: (p) => <span className="mono">{p.quantity} {p.unit}</span> },
];

function Field({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  inputMode?: 'decimal';
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input className="input" value={value} onChange={onChange} placeholder={placeholder} inputMode={inputMode} />
    </label>
  );
}

export function NewProductionOrderForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const { submit } = useOffline();
  const [form, setForm] = useState(EMPTY);
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [planned, setPlanned] = useState<PlannedComponent[]>([]);
  const [halal, setHalal] = useState<HalalVerdict | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  function reset() {
    setForm(EMPTY);
    setPlanned([]);
    setHalal(null);
    setStep('edit');
  }

  async function preview() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/production/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          formulaVersionId: form.formulaVersionId,
          plannedQuantity: Number(form.plannedQuantity),
          unit: form.unit,
        }),
      });
      const body = await res.json();
      if (!res.ok) setMsg({ kind: 'err', text: body.error ?? 'Could not preview batch.' });
      else {
        const payload = body.data as { components: PlannedComponent[]; halal: HalalVerdict | null };
        setPlanned(payload.components);
        setHalal(payload.halal);
        setStep('preview');
      }
    } catch {
      setMsg({ kind: 'err', text: 'Preview needs a connection. You can still create the order.' });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setMsg(null);
    const res = await submit('/api/production', { ...form, plannedQuantity: Number(form.plannedQuantity) });
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: 'ok', text: 'Order created.' });
      reset();
      onSubmitted?.();
    } else if (res.queued) {
      setMsg({ kind: 'ok', text: 'Offline — order queued and will sync when you reconnect.' });
      reset();
    } else {
      setMsg({ kind: 'err', text: res.error ?? 'Failed to create order.' });
    }
  }

  const canPreview = form.formulaVersionId && Number(form.plannedQuantity) > 0;
  const canCreate = canPreview && form.code && form.productId && form.warehouseId;
  const msgClass = (kind: 'ok' | 'err') => `mt-3 text-[0.85rem] ${kind === 'ok' ? 'text-ok' : 'text-bad'}`;

  return (
    <div className="card mb-5">
      <h2 className="mb-4 text-[1.05rem] font-semibold tracking-[-0.01em]">New production order</h2>

      {step === 'edit' ? (
        <>
          <div className={GRID}>
            <Field label="Order code" value={form.code} onChange={set('code')} placeholder="PO-2026-001" />
            <Field label="Batch quantity" value={form.plannedQuantity} onChange={set('plannedQuantity')} inputMode="decimal" />
            <label className="flex flex-col gap-1.5">
              <span className="label">Unit</span>
              <select className="input" value={form.unit} onChange={set('unit')}>
                {(['kg', 'g', 'mg', 'l', 'ml'] as Unit[]).map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <Field label="Product ID" value={form.productId} onChange={set('productId')} placeholder="uuid" />
            <Field label="Formula version ID" value={form.formulaVersionId} onChange={set('formulaVersionId')} placeholder="uuid" />
            <Field label="Warehouse ID" value={form.warehouseId} onChange={set('warehouseId')} placeholder="uuid" />
          </div>
          {msg && <p className={msgClass(msg.kind)}>{msg.text}</p>}
          <div className="mt-[1.1rem] flex flex-wrap gap-2.5">
            <button className="btn" onClick={preview} disabled={busy || !canPreview}>
              {busy ? 'Calculating…' : 'Preview batch'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="prose-justify mb-4 text-[0.88rem] text-muted">
            Planned consumption for {form.plannedQuantity} {form.unit}. Components are scaled to sum
            exactly to the batch.
          </p>
          <DataTable columns={previewColumns} rows={planned} rowKey={(p) => p.rawMaterialId} />

          {halal && !halal.compliant && (
            <div className="mt-4 rounded border border-border-strong bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge badge-bad">Not halal-compliant</span>
                <span className="text-[0.82rem] text-muted">
                  This recipe will be blocked at completion until these materials are certified (an
                  admin can override with a reason):
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {halal.offending.map((o) => (
                  <li key={o.sku} className="text-[0.83rem]">
                    <span className="mono">{o.sku}</span> <span className="text-soft">{o.name}</span>{' '}
                    <span className="text-bad">— {o.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {halal?.compliant && (
            <p className="mt-3 flex items-center gap-2 text-[0.82rem] text-muted">
              <span className="badge badge-ok">Halal compliant</span>
              Every recipe material is certified and unexpired.
            </p>
          )}
          {msg && <p className={msgClass(msg.kind)}>{msg.text}</p>}
          <div className="mt-[1.1rem] flex flex-wrap gap-2.5">
            <button className="btn btn-ghost" onClick={() => setStep('edit')} disabled={busy}>Edit</button>
            <button className="btn" onClick={confirm} disabled={busy || !canCreate}>
              {busy ? 'Creating…' : 'Confirm & create'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

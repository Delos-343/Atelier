'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useOnline } from '@/lib/offline/use-online';
import { api, errMsg } from '@/lib/api-client';

type Basis = 'percent' | 'mass';
const UNITS = ['kg', 'g', 'mg', 'l', 'ml'] as const;

interface Material {
  id: string;
  sku: string;
  name: string;
  base_unit: string;
}
interface ProductOpt {
  id: string;
  sku: string;
  name: string;
}
interface ComponentDetail {
  id: string;
  rawMaterialId: string;
  material: { sku: string; name: string; baseUnit: string } | null;
  quantity: number;
  unit: string;
  sequence: number;
}
interface VersionDetail {
  id: string;
  versionNo: number;
  basis: Basis;
  isLocked: boolean;
  createdAt: string;
  components: ComponentDetail[];
}
interface Detail {
  id: string;
  code: string;
  name: string;
  productId: string;
  product: { sku: string; name: string } | null;
  versions: VersionDetail[];
}

interface Row {
  key: string;
  raw_material_id: string;
  quantity: string;
  unit: string;
}

export function FormulaEditor({ formulaId }: { formulaId: string }) {
  const online = useOnline();
  const keySeq = useRef(0);
  const nextKey = () => `r${keySeq.current++}`;

  const [detail, setDetail] = useState<Detail | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedVid, setSelectedVid] = useState<string | null>(null);

  const [header, setHeader] = useState({ code: '', name: '', product_id: '' });
  const [headerBusy, setHeaderBusy] = useState(false);
  const [headerMsg, setHeaderMsg] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [newBasis, setNewBasis] = useState<Basis>('percent');
  const [cloneFrom, setCloneFrom] = useState<string>('');
  const [versionBusy, setVersionBusy] = useState(false);
  const [versionErr, setVersionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<Detail>(`/api/admin/formulas/${formulaId}`);
      setDetail(d);
      setHeader({ code: d.code, name: d.name, product_id: d.productId });
      setSelectedVid((prev) => {
        if (prev && d.versions.some((v) => v.id === prev)) return prev;
        return d.versions.length ? d.versions[d.versions.length - 1].id : null;
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }, [formulaId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api<Material[]>('/api/admin/materials')
      .then((m) => setMaterials(m ?? []))
      .catch(() => setMaterials([]));
    api<ProductOpt[]>('/api/admin/products')
      .then((p) => setProducts(p ?? []))
      .catch(() => setProducts([]));
  }, []);

  const selected = detail?.versions.find((v) => v.id === selectedVid) ?? null;

  // Repopulate the working copy whenever the selected version (or fresh detail) changes.
  useEffect(() => {
    setSaveErr(null);
    if (!selected) {
      setRows([]);
      return;
    }
    setRows(
      selected.components.map((c) => ({
        key: nextKey(),
        raw_material_id: c.rawMaterialId,
        quantity: String(c.quantity),
        unit: c.unit,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVid, detail]);

  function patchRow(key: string, field: keyof Row, value: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, [field]: value };
        if (field === 'raw_material_id') {
          const mat = materials.find((m) => m.id === value);
          if (mat && !r.unit) next.unit = mat.base_unit;
          if (mat && r.unit === '') next.unit = mat.base_unit;
        }
        return next;
      }),
    );
  }
  function addRow() {
    setRows((rs) => [...rs, { key: nextKey(), raw_material_id: '', quantity: '', unit: 'g' }]);
  }
  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  const isPercent = selected?.basis === 'percent';
  const parsed = rows.map((r) => ({ ...r, q: parseFloat(r.quantity) }));
  const incomplete = parsed.some((r) => !r.raw_material_id || !(r.q > 0));
  const ids = parsed.map((r) => r.raw_material_id).filter(Boolean);
  const hasDup = new Set(ids).size !== ids.length;
  const total = parsed.reduce((a, r) => a + (r.q > 0 ? r.q : 0), 0);
  const sumOk = Math.abs(total - 100) <= 0.01;
  const canSave = online && !saveBusy && rows.length > 0 && !incomplete && !hasDup;
  const canLock = canSave && (!isPercent || sumOk);

  async function saveComponents(lock: boolean) {
    if (!selectedVid) return;
    setSaveErr(null);
    setSaveBusy(true);
    try {
      const components = rows.map((r, i) => ({
        raw_material_id: r.raw_material_id,
        quantity: parseFloat(r.quantity),
        unit: r.unit,
        sequence: i,
      }));
      await api(`/api/admin/formula-versions/${selectedVid}`, {
        method: 'PUT',
        body: JSON.stringify({ components, lock }),
      });
      await load();
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function createVersion(basis: Basis, cloneFromId?: string) {
    setVersionErr(null);
    setVersionBusy(true);
    try {
      const created = await api<{ id: string }>('/api/admin/formula-versions', {
        method: 'POST',
        body: JSON.stringify({
          formula_id: formulaId,
          basis,
          clone_from_version_id: cloneFromId || undefined,
        }),
      });
      setCloneFrom('');
      await load();
      setSelectedVid(created.id);
    } catch (e) {
      setVersionErr(errMsg(e));
    } finally {
      setVersionBusy(false);
    }
  }

  async function deleteVersion() {
    if (!selectedVid) return;
    if (!window.confirm('Delete this version? This cannot be undone.')) return;
    setSaveErr(null);
    setSaveBusy(true);
    try {
      await api(`/api/admin/formula-versions/${selectedVid}`, { method: 'DELETE' });
      setSelectedVid(null);
      await load();
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setSaveBusy(false);
    }
  }

  async function saveHeader() {
    setHeaderMsg(null);
    if (!header.code.trim() || !header.name.trim() || !header.product_id) {
      setHeaderMsg('Code, name, and product are all required.');
      return;
    }
    setHeaderBusy(true);
    try {
      await api(`/api/admin/formulas/${formulaId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          code: header.code.trim(),
          name: header.name.trim(),
          product_id: header.product_id,
        }),
      });
      await load();
      setHeaderMsg('Saved.');
    } catch (e) {
      setHeaderMsg(errMsg(e));
    } finally {
      setHeaderBusy(false);
    }
  }

  if (error) {
    return (
      <div className="grid gap-3">
        <p className="text-[0.9rem] text-bad">{error}</p>
        <Link href="/admin/formulas" className="text-[0.85rem] text-accent">
          ← Back to formulas
        </Link>
      </div>
    );
  }
  if (!detail) return <p className="text-[0.9rem] text-muted">Loading…</p>;

  return (
    <div className="grid gap-5">
      <Link href="/admin/formulas" className="text-[0.85rem] text-accent">
        ← Back to formulas
      </Link>

      {!online && (
        <p className="badge bg-surface-2">Offline — changes can be saved once reconnected.</p>
      )}

      {/* Header */}
      <section className="card grid gap-3">
        <span className="section-label">Formula</span>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label">Code</span>
            <input
              className="input"
              value={header.code}
              onChange={(e) => setHeader({ ...header, code: e.target.value })}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Name</span>
            <input
              className="input"
              value={header.name}
              onChange={(e) => setHeader({ ...header, name: e.target.value })}
            />
          </label>
        </div>
        <label className="block">
          <span className="label">Product</span>
          <select
            className="input"
            value={header.product_id}
            onChange={(e) => setHeader({ ...header, product_id: e.target.value })}
          >
            <option value="" disabled>
              Select a product…
            </option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button className="btn btn-sm" onClick={saveHeader} disabled={headerBusy || !online}>
            {headerBusy ? 'Saving…' : 'Save details'}
          </button>
          {headerMsg && (
            <span
              className={`text-[0.82rem] ${headerMsg === 'Saved.' ? 'text-ok' : 'text-bad'}`}
            >
              {headerMsg}
            </span>
          )}
        </div>
      </section>

      {/* Versions */}
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="section-label">Versions</span>
          {detail.versions.map((v) => {
            const active = v.id === selectedVid;
            return (
              <button
                key={v.id}
                onClick={() => setSelectedVid(v.id)}
                className={`badge cursor-pointer ${active ? 'border-border-strong bg-surface-2 text-text' : ''}`}
              >
                v{v.versionNo}
                <span className="ml-1.5 text-muted">{v.isLocked ? '· locked' : '· draft'}</span>
              </button>
            );
          })}
          {detail.versions.length === 0 && (
            <span className="text-[0.85rem] text-muted">No versions yet.</span>
          )}
        </div>

        {/* New version */}
        <div className="card grid gap-3">
          <span className="section-label">New version</span>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="label">Basis</span>
              <select
                className="input w-auto"
                value={newBasis}
                onChange={(e) => setNewBasis(e.target.value as Basis)}
              >
                <option value="percent">percent (sums to 100)</option>
                <option value="mass">mass (absolute amounts)</option>
              </select>
            </label>
            <label className="block">
              <span className="label">Clone from</span>
              <select
                className="input w-auto"
                value={cloneFrom}
                onChange={(e) => setCloneFrom(e.target.value)}
              >
                <option value="">— empty —</option>
                {detail.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNo}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-sm"
              onClick={() => createVersion(newBasis, cloneFrom)}
              disabled={versionBusy || !online}
            >
              {versionBusy ? 'Creating…' : 'Create version'}
            </button>
          </div>
          {versionErr && <p className="text-[0.85rem] text-bad">{versionErr}</p>}
        </div>
      </section>

      {/* Selected version editor */}
      {selected && (
        <section className="card grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="section-label">
              Editing v{selected.versionNo} · {selected.basis}
              {selected.isLocked && <span className="ml-2 text-warn">locked</span>}
            </span>
            {isPercent && !selected.isLocked && (
              <span className={`mono text-[0.9rem] ${sumOk ? 'text-ok' : 'text-bad'}`}>
                Σ {total.toFixed(2)} / 100 {sumOk ? '✓' : '✗'}
              </span>
            )}
          </div>

          {selected.isLocked ? (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th className="ta-r">Quantity</th>
                      <th>Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.components.map((c) => (
                      <tr key={c.id}>
                        <td data-label="Material">
                          {c.material ? `${c.material.sku} — ${c.material.name}` : c.rawMaterialId}
                        </td>
                        <td data-label="Quantity" className="ta-r mono">
                          {c.quantity}
                        </td>
                        <td data-label="Unit" className="mono">
                          {c.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[0.85rem] text-muted">
                This version is locked and immutable. Create a new version to make changes.
              </p>
              <div>
                <button
                  className="btn btn-sm"
                  onClick={() => createVersion(selected.basis, selected.id)}
                  disabled={versionBusy || !online}
                >
                  New version from this
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: '50%' }}>Material</th>
                      <th className="ta-r">Quantity{isPercent ? ' (%)' : ''}</th>
                      <th>Unit</th>
                      <th aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const mat = materials.find((m) => m.id === r.raw_material_id);
                      return (
                        <tr key={r.key}>
                          <td data-label="Material">
                            <select
                              className="input"
                              value={r.raw_material_id}
                              onChange={(e) => patchRow(r.key, 'raw_material_id', e.target.value)}
                            >
                              <option value="" disabled>
                                {materials.length ? 'Select material…' : 'No materials available'}
                              </option>
                              {materials.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.sku} — {m.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td data-label="Quantity" className="ta-r">
                            <input
                              className="input ta-r"
                              type="number"
                              min="0"
                              step="any"
                              inputMode="decimal"
                              value={r.quantity}
                              onChange={(e) => patchRow(r.key, 'quantity', e.target.value)}
                            />
                          </td>
                          <td data-label="Unit">
                            <select
                              className="input w-auto"
                              value={r.unit}
                              onChange={(e) => patchRow(r.key, 'unit', e.target.value)}
                              title={mat ? `base unit ${mat.base_unit}` : undefined}
                            >
                              {UNITS.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td data-label="" className="ta-r">
                            <button
                              className="icon-btn"
                              onClick={() => removeRow(r.key)}
                              aria-label="Remove component"
                              title="Remove"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-[0.85rem] text-muted">
                          No components. Add one to begin.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-sm btn-ghost" onClick={addRow} disabled={!online}>
                  + Add component
                </button>
                {hasDup && <span className="text-[0.82rem] text-bad">Duplicate material selected.</span>}
                {!isPercent && rows.length > 0 && (
                  <span className="text-[0.82rem] text-muted">
                    Mass basis — quantities are absolute; units may differ per line.
                  </span>
                )}
              </div>

              {saveErr && <p className="text-[0.85rem] text-bad">{saveErr}</p>}

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-sm" onClick={() => saveComponents(false)} disabled={!canSave}>
                  {saveBusy ? 'Saving…' : 'Save draft'}
                </button>
                <button
                  className="btn btn-sm btn-ok"
                  onClick={() => saveComponents(true)}
                  disabled={!canLock}
                  title={
                    isPercent && !sumOk
                      ? 'Percent components must sum to 100 before locking'
                      : 'Lock this version (makes it immutable)'
                  }
                >
                  Save &amp; lock
                </button>
                <button
                  className="btn btn-sm btn-bad ml-auto"
                  onClick={deleteVersion}
                  disabled={saveBusy || !online}
                >
                  Delete version
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

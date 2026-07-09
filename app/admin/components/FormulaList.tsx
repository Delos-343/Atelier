'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOnline } from '@/lib/offline/use-online';
import { api, errMsg } from '@/lib/api-client';

interface FormulaRow {
  id: string;
  code: string;
  name: string;
  product: { sku: string; name: string } | null;
  versionCount: number;
  latest: { versionNo: number; isLocked: boolean } | null;
}
interface ProductOpt {
  id: string;
  sku: string;
  name: string;
}

export function FormulaList() {
  const router = useRouter();
  const online = useOnline();
  const [rows, setRows] = useState<FormulaRow[] | null>(null);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', product_id: '' });
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api<FormulaRow[]>('/api/admin/formulas'));
    } catch (e) {
      setError(errMsg(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api<ProductOpt[]>('/api/admin/products')
      .then((p) => setProducts(p ?? []))
      .catch(() => setProducts([]));
  }, []);

  async function submit() {
    setFormErr(null);
    if (!form.code.trim() || !form.name.trim() || !form.product_id) {
      setFormErr('Code, name, and product are all required.');
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ id: string }>('/api/admin/formulas', {
        method: 'POST',
        body: JSON.stringify({
          code: form.code.trim(),
          name: form.name.trim(),
          product_id: form.product_id,
        }),
      });
      router.push(`/admin/formulas/${created.id}`);
    } catch (e) {
      setFormErr(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {!online && (
        <p className="badge bg-surface-2">Offline — formula editing is available when reconnected.</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="section-label">
          {rows ? `${rows.length} formula${rows.length === 1 ? '' : 's'}` : 'Loading…'}
        </span>
        <button
          className="btn btn-sm"
          onClick={() => {
            setOpen((v) => !v);
            setFormErr(null);
          }}
          disabled={!online}
        >
          {open ? 'Cancel' : 'New formula'}
        </button>
      </div>

      {open && (
        <div className="card grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="label">
                Code<span className="text-bad"> *</span>
              </span>
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="EDP-001"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="label">
                Name<span className="text-bad"> *</span>
              </span>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Néroli Eau de Parfum"
              />
            </label>
          </div>
          <label className="block">
            <span className="label">
              Product<span className="text-bad"> *</span>
            </span>
            <select
              className="input"
              value={form.product_id}
              onChange={(e) => setForm({ ...form, product_id: e.target.value })}
            >
              <option value="" disabled>
                {products.length ? 'Select a product…' : 'No products — add one under Products first'}
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
          </label>
          {formErr && <p className="text-[0.85rem] text-bad">{formErr}</p>}
          <div>
            <button className="btn" onClick={submit} disabled={busy || !online}>
              {busy ? 'Creating…' : 'Create formula'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[0.9rem] text-bad">{error}</p>}

      {rows && rows.length === 0 && !error && (
        <p className="text-[0.9rem] text-muted">
          No formulas yet. Create one to start building versioned recipes.
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Product</th>
                <th className="ta-r">Versions</th>
                <th>Latest</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td data-label="Code">
                    <Link href={`/admin/formulas/${f.id}`} className="mono text-accent">
                      {f.code}
                    </Link>
                  </td>
                  <td data-label="Name">{f.name}</td>
                  <td data-label="Product" className="text-soft">
                    {f.product ? `${f.product.sku} — ${f.product.name}` : '—'}
                  </td>
                  <td data-label="Versions" className="ta-r mono">
                    {f.versionCount}
                  </td>
                  <td data-label="Latest">
                    {f.latest ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="mono">v{f.latest.versionNo}</span>
                        <span className={`badge ${f.latest.isLocked ? 'bg-surface-2' : ''}`}>
                          {f.latest.isLocked ? 'locked' : 'draft'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">none</span>
                    )}
                  </td>
                  <td data-label="" className="ta-r">
                    <Link href={`/admin/formulas/${f.id}`} className="text-[0.82rem] text-accent">
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

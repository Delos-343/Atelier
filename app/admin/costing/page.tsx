'use client';

import { useEffect, useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import type { CostingSettings, ProductCostingRate } from '@/server/settings';

/** fraction (0.15) → clean percent string ("15"), trimming float noise. */
const toPct = (frac: number) => String(Number((frac * 100).toFixed(4)));

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  base_unit: string;
}

const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

export default function CostingSettingsPage() {
  // ── plant-wide standard rates ──────────────────────────────────────────────
  const { data, error, loading, reload } = useApiData<CostingSettings>('/api/admin/costing');
  const [laborRate, setLaborRate] = useState('');
  const [overheadPct, setOverheadPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (data) {
      setLaborRate(String(data.laborRatePerHour));
      setOverheadPct(toPct(data.overheadRate));
    }
  }, [data]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const laborRatePerHour = Number(laborRate);
      const overheadRate = Number(overheadPct) / 100;
      if (!Number.isFinite(laborRatePerHour) || !Number.isFinite(overheadRate)) {
        throw new Error('Enter valid numbers.');
      }
      await api('/api/admin/costing', {
        method: 'PUT',
        body: JSON.stringify({ laborRatePerHour, overheadRate }),
      });
      setMsg({ kind: 'ok', text: 'Rates saved. New completions will use them.' });
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  // ── per-product overrides ──────────────────────────────────────────────────
  const overrides = useApiData<ProductCostingRate[]>('/api/admin/costing/products');
  const products = useApiData<ProductRow[]>('/api/admin/products');
  const [ovProductId, setOvProductId] = useState('');
  const [ovLabor, setOvLabor] = useState('');
  const [ovOverheadPct, setOvOverheadPct] = useState('');
  const [ovBusy, setOvBusy] = useState(false);
  const [ovMsg, setOvMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function resetOvForm() {
    setOvProductId('');
    setOvLabor('');
    setOvOverheadPct('');
  }

  function editOverride(r: ProductCostingRate) {
    setOvProductId(r.productId);
    setOvLabor(r.laborRatePerHour === null ? '' : String(r.laborRatePerHour));
    setOvOverheadPct(r.overheadRate === null ? '' : toPct(r.overheadRate));
    setOvMsg(null);
  }

  async function saveOverride() {
    setOvBusy(true);
    setOvMsg(null);
    try {
      if (!ovProductId) throw new Error('Select a product.');
      const laborRatePerHour = ovLabor.trim() === '' ? null : Number(ovLabor);
      const overheadRate = ovOverheadPct.trim() === '' ? null : Number(ovOverheadPct) / 100;
      if (laborRatePerHour !== null && !Number.isFinite(laborRatePerHour)) {
        throw new Error('Labor rate must be a number.');
      }
      if (overheadRate !== null && !Number.isFinite(overheadRate)) {
        throw new Error('Overhead must be a number.');
      }
      if (laborRatePerHour === null && overheadRate === null) {
        throw new Error('Set at least one rate, or remove the override.');
      }
      await api('/api/admin/costing/products', {
        method: 'PUT',
        body: JSON.stringify({ productId: ovProductId, laborRatePerHour, overheadRate }),
      });
      setOvMsg({ kind: 'ok', text: 'Override saved. New completions of this product will use it.' });
      resetOvForm();
      overrides.reload();
    } catch (e) {
      setOvMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setOvBusy(false);
    }
  }

  async function removeOverride(productId: string) {
    setOvBusy(true);
    setOvMsg(null);
    try {
      await api(`/api/admin/costing/products?productId=${encodeURIComponent(productId)}`, {
        method: 'DELETE',
      });
      setOvMsg({ kind: 'ok', text: 'Override removed — the product inherits plant-wide rates again.' });
      if (ovProductId === productId) resetOvForm();
      overrides.reload();
    } catch (e) {
      setOvMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setOvBusy(false);
    }
  }

  const rows = overrides.data ?? [];

  return (
    <Page>
      <PageHeader title="Costing rates">
        Plant-wide standard rates applied when a production order is completed. Labor cost is entered
        hours × the rate below; overhead is a percentage of prime cost (material + labor). Both default
        to zero — until set, finished-goods cost is material only.
      </PageHeader>

      <div className="mt-4 max-w-lg">
        {loading && !data ? (
          <p className={stateBox}>Loading…</p>
        ) : error && !data ? (
          <p className={stateBox}>Could not load — {error}</p>
        ) : (
          <div className="card flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="laborRate" className="label">
                Labor rate / hour
              </label>
              <input
                id="laborRate"
                className="input"
                inputMode="decimal"
                value={laborRate}
                onChange={(e) => setLaborRate(e.target.value)}
                placeholder="0.00"
              />
              <span className="text-[0.78rem] text-muted">Currency per direct labor hour.</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="overheadPct" className="label">
                Overhead rate (% of prime cost)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="overheadPct"
                  className="input w-32"
                  inputMode="decimal"
                  value={overheadPct}
                  onChange={(e) => setOverheadPct(e.target.value)}
                  placeholder="0"
                />
                <span className="text-muted">%</span>
              </div>
              <span className="text-[0.78rem] text-muted">
                Applied to material + labor. e.g. 15 means overhead = 15% of prime cost.
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button className="btn btn-sm" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save rates'}
              </button>
              {data?.updatedAt && (
                <span className="text-[0.76rem] text-muted">
                  Last updated {new Date(data.updatedAt).toLocaleString()}
                </span>
              )}
            </div>

            {msg && (
              <p className={msg.kind === 'ok' ? 'text-[0.85rem] text-accent' : 'text-[0.85rem] text-bad'}>
                {msg.text}
              </p>
            )}
          </div>
        )}
      </div>

      <section className="mt-10 max-w-3xl">
        <h2 className="text-[1.05rem] font-semibold">Per-product overrides</h2>
        <p className="mt-1 text-[0.85rem] text-muted">
          Optionally give a product its own labor and/or overhead rate. A blank field inherits the
          plant-wide standard above; a product with no row here inherits both. Overrides apply to
          future completions only.
        </p>

        <div className="card mt-4 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ovProduct" className="label">
                Product
              </label>
              <select
                id="ovProduct"
                className="input"
                value={ovProductId}
                onChange={(e) => setOvProductId(e.target.value)}
              >
                <option value="">Select a product…</option>
                {(products.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ovLabor" className="label">
                Labor rate / hour
              </label>
              <input
                id="ovLabor"
                className="input"
                inputMode="decimal"
                value={ovLabor}
                onChange={(e) => setOvLabor(e.target.value)}
                placeholder="inherit"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ovOverhead" className="label">
                Overhead (% of prime)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="ovOverhead"
                  className="input w-full"
                  inputMode="decimal"
                  value={ovOverheadPct}
                  onChange={(e) => setOvOverheadPct(e.target.value)}
                  placeholder="inherit"
                />
                <span className="text-muted">%</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn btn-sm" onClick={saveOverride} disabled={ovBusy}>
              {ovBusy ? 'Saving…' : 'Save override'}
            </button>
            {ovProductId && (
              <button className="btn btn-sm btn-ghost" onClick={resetOvForm} disabled={ovBusy}>
                Clear
              </button>
            )}
          </div>
          {ovMsg && (
            <p className={ovMsg.kind === 'ok' ? 'text-[0.85rem] text-accent' : 'text-[0.85rem] text-bad'}>
              {ovMsg.text}
            </p>
          )}
        </div>

        <div className="mt-4">
          {overrides.loading && !overrides.data ? (
            <p className={stateBox}>Loading…</p>
          ) : overrides.error && !overrides.data ? (
            <p className={stateBox}>Could not load — {overrides.error}</p>
          ) : rows.length === 0 ? (
            <p className={stateBox}>
              No per-product overrides yet — every product inherits the plant-wide rates.
            </p>
          ) : (
            <div className="card overflow-x-auto p-0">
              <div className="w-full overflow-x-auto"><table className="w-full text-[0.85rem] min-w-[34rem]">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-2.5 font-medium">Product</th>
                    <th className="px-4 py-2.5 font-medium">Labor / hr</th>
                    <th className="px-4 py-2.5 font-medium">Overhead</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.productId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">
                        <span className="mono">{r.sku}</span>{' '}
                        <span className="text-muted">— {r.name}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.laborRatePerHour === null ? (
                          <span className="text-muted">inherit</span>
                        ) : (
                          r.laborRatePerHour
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.overheadRate === null ? (
                          <span className="text-muted">inherit</span>
                        ) : (
                          `${toPct(r.overheadRate)}%`
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => editOverride(r)}
                          disabled={ovBusy}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-sm btn-ghost text-bad"
                          onClick={() => removeOverride(r.productId)}
                          disabled={ovBusy}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </div>
      </section>
    </Page>
  );
}

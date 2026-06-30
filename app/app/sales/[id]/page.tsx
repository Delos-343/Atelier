'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { useRole } from '../../../components/auth/SessionProvider';
import { api, errMsg } from '@/lib/api-client';
import type { SalesOrderDetail, CostedLine } from '@/server/sales';
import { money, moneyOrDash } from '@/lib/format';
import { SALES_STATUS_CLASS } from '../status';

const buildLineColumns = (realized: boolean): Column<CostedLine>[] => {
  const product: Column<CostedLine> = {
    key: 'product',
    header: 'Product',
    render: (l) => (
      <span>
        <span className="mono">{l.sku}</span> <span className="text-soft">{l.name}</span>
      </span>
    ),
  };
  const price: Column<CostedLine> = {
    key: 'price',
    header: 'Unit price',
    align: 'right',
    render: (l) => <span className="mono">{money(l.unitPrice)}</span>,
  };
  if (realized) {
    return [
      product,
      { key: 'ordered', header: 'Ordered', align: 'right', render: (l) => <span className="mono">{l.quantity} {l.unit}</span> },
      { key: 'shipped', header: 'Shipped', align: 'right', render: (l) => <span className="mono">{l.shippedQuantity} {l.unit}</span> },
      price,
      { key: 'cogs', header: 'COGS', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.cogs)}</span> },
      { key: 'rmargin', header: 'Realized margin', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.realizedMargin)}</span> },
    ];
  }
  return [
    product,
    { key: 'qty', header: 'Qty', align: 'right', render: (l) => <span className="mono">{l.quantity} {l.unit}</span> },
    price,
    { key: 'cost', header: 'Est. unit cost', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.estUnitCost)}</span> },
    { key: 'rev', header: 'Revenue', align: 'right', render: (l) => <span className="mono">{money(l.lineRevenue)}</span> },
    { key: 'emargin', header: 'Exp. margin', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.expectedMargin)}</span> },
  ];
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="mono text-[1.4rem] font-semibold leading-none">{value}</div>
      <div className="mt-2 text-[0.74rem] uppercase tracking-[0.08em] text-muted">{label}</div>
    </div>
  );
}

export default function SalesOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const role = useRole();
  const { data: o, error, loading, reload } = useApiData<SalesOrderDetail>(`/api/sales/${params.id}`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [qtys, setQtys] = useState<Record<string, string>>({});

  const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

  async function setStatus(status: 'confirmed' | 'cancelled') {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function ship() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/ship`, { method: 'POST' });
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const lineCap = (l: CostedLine): number =>
    Math.min(l.quantity - l.shippedQuantity, l.availableQuantity);

  function openSplit() {
    if (!o) return;
    const init: Record<string, string> = {};
    for (const l of o.lines) {
      const cap = lineCap(l);
      if (cap > 0) init[l.lineId] = String(cap);
    }
    setQtys(init);
    setMsg(null);
    setSplitOpen(true);
  }

  async function shipLines() {
    const lines = Object.entries(qtys)
      .map(([lineId, v]) => ({ lineId, quantity: Number(v) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (lines.length === 0) {
      setMsg('Enter a quantity for at least one line.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/ship-lines`, {
        method: 'POST',
        body: JSON.stringify({ lines }),
      });
      setSplitOpen(false);
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const realized = !!o && (o.status === 'shipped' || o.status === 'partially_shipped');
  const outstanding = o ? o.lines.reduce((s, l) => s + Math.max(0, l.quantity - l.shippedQuantity), 0) : 0;

  return (
    <Page>
      <PageHeader title="Sales order">
        Expected-margin preview before shipment; realized COGS and margin from the issued lots as the
        order ships — in full or in part, with the remainder on backorder.
      </PageHeader>

      <Link href="/app/sales" className="text-[0.85rem] text-muted hover:text-text">
        ← All orders
      </Link>

      <div className="mt-4">
        {loading && !o ? (
          <p className={stateBox}>Loading…</p>
        ) : error && !o ? (
          <p className={stateBox}>Could not load — {error}</p>
        ) : !o ? (
          <p className={stateBox}>No order found.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono text-[1.1rem]">{o.code}</span>
              <span className={`badge ${SALES_STATUS_CLASS[o.status] ?? ''}`}>{o.status}</span>
              <span className="text-[0.9rem] text-text-soft">
                {o.customer ? `${o.customer.code} · ${o.customer.name}` : '—'}
              </span>
              <span className="mono text-[0.85rem] text-muted">{o.orderDate}</span>
            </div>

            {role === 'admin' &&
              (o.status === 'draft' || o.status === 'confirmed' || o.status === 'partially_shipped') && (
                <div className="flex flex-wrap gap-2.5">
                  {o.status === 'draft' && (
                    <button className="btn btn-sm" onClick={() => setStatus('confirmed')} disabled={busy}>
                      {busy ? 'Working…' : 'Confirm order'}
                    </button>
                  )}
                  {(o.status === 'confirmed' || o.status === 'partially_shipped') && (
                    <>
                      <button className="btn btn-sm" onClick={ship} disabled={busy}>
                        {busy ? 'Shipping…' : 'Ship available'}
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={openSplit} disabled={busy}>
                        Ship specific…
                      </button>
                    </>
                  )}
                  {(o.status === 'draft' || o.status === 'confirmed') && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setStatus('cancelled')} disabled={busy}>
                      Cancel order
                    </button>
                  )}
                </div>
              )}

            {splitOpen && (o.status === 'confirmed' || o.status === 'partially_shipped') && (
              <div className="card flex flex-col gap-3">
                <div className="section-label">Ship specific quantities</div>
                {o.lines.filter((l) => l.quantity - l.shippedQuantity > 0).length === 0 ? (
                  <p className="text-[0.85rem] text-muted">Every line is already fully shipped.</p>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
                      {o.lines
                        .filter((l) => l.quantity - l.shippedQuantity > 0)
                        .map((l) => {
                          const cap = lineCap(l);
                          return (
                            <div key={l.lineId} className="flex flex-wrap items-center gap-3">
                              <span className="min-w-[10rem] flex-1">
                                <span className="mono">{l.sku}</span>{' '}
                                <span className="text-soft">{l.name}</span>
                              </span>
                              <span className="text-[0.78rem] text-muted">
                                {l.quantity - l.shippedQuantity} outstanding · {l.availableQuantity} available
                              </span>
                              <input
                                type="number"
                                className="input w-24"
                                min={0}
                                max={cap}
                                step="any"
                                value={qtys[l.lineId] ?? ''}
                                disabled={cap <= 0 || busy}
                                onChange={(e) => setQtys((q) => ({ ...q, [l.lineId]: e.target.value }))}
                              />
                              <span className="text-[0.78rem] text-muted">{l.unit}</span>
                            </div>
                          );
                        })}
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      <button className="btn btn-sm" onClick={shipLines} disabled={busy}>
                        {busy ? 'Shipping…' : 'Ship these quantities'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setSplitOpen(false)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {msg && <p className="text-[0.85rem] text-bad">{msg}</p>}

            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
              {realized ? (
                <>
                  <Stat label="Shipped revenue" value={moneyOrDash(o.realizedRevenue)} />
                  <Stat label="Realized COGS" value={moneyOrDash(o.realizedCogs)} />
                  <Stat label="Realized margin" value={moneyOrDash(o.realizedMargin)} />
                </>
              ) : (
                <>
                  <Stat label="Revenue" value={money(o.totalRevenue)} />
                  <Stat label="Expected COGS" value={money(o.expectedCogs)} />
                  <Stat label="Expected margin" value={moneyOrDash(o.expectedMargin)} />
                </>
              )}
            </div>

            <div>
              <h2 className="section-label mb-[0.85rem]">Lines</h2>
              <DataTable columns={buildLineColumns(realized)} rows={o.lines} rowKey={(l) => l.lineId} />
              {!realized && o.expectedMargin == null && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  Expected margin is shown only where the product has costed finished stock on hand;
                  realized margin is recorded at shipment.
                </p>
              )}
              {o.status === 'partially_shipped' && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  Partially shipped — {outstanding} unit{outstanding === 1 ? '' : 's'} on backorder.
                  Shipped revenue, COGS, and margin cover only what has been dispatched; ship again once
                  stock is available.
                </p>
              )}
              {o.status === 'shipped' && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  COGS and realized margin are frozen from the specific finished lots issued at shipment.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge, PRODUCTION_STATUS_TONES } from '../../../components/StatusBadge';
import { useRole } from '../../../components/auth/SessionProvider';
import type { ProductionOrderCost, CostLine } from '@/server/costing';
import type { HalalVerdict } from '@/server/compliance';
import { money } from '@/lib/format';
import { api, errMsg } from '@/lib/api-client';
import { Stat } from '../../../components/Stat';

const lineColumns: Column<CostLine>[] = [
  {
    key: 'material',
    header: 'Material',
    render: (l) => (
      <span>
        <span className="mono">{l.sku}</span> <span className="text-soft">{l.name}</span>
      </span>
    ),
  },
  {
    key: 'consumed',
    header: 'Consumed',
    align: 'right',
    render: (l) => (
      <span className="mono">
        {l.consumedQuantity} {l.unit}
      </span>
    ),
  },
  {
    key: 'cost',
    header: 'Cost',
    align: 'right',
    render: (l) => <span className="mono">{money(l.lineCost)}</span>,
  },
];

/** The order's halal verdict — green when the recipe is clean, otherwise the offenders. */
function HalalVerdictPanel({ verdict }: { verdict: HalalVerdict }) {
  if (verdict.compliant) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-ok">Halal compliant</span>
        <span className="text-[0.82rem] text-muted">
          Every recipe material is certified and unexpired.
        </span>
      </div>
    );
  }
  return (
    <div className="rounded border border-border-strong bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-bad">Not halal-compliant</span>
        <span className="text-[0.82rem] text-muted">
          Completion is blocked until every recipe material is certified — fix these in Admin → Halal
          compliance.
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {verdict.offending.map((o) => (
          <li key={o.sku} className="text-[0.85rem]">
            <span className="mono">{o.sku}</span> <span className="text-soft">{o.name}</span>{' '}
            <span className="text-bad">— {o.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}


export default function ProductionOrderCostPage() {
  const params = useParams<{ id: string }>();
  const { data: c, error, loading, reload } = useApiData<ProductionOrderCost>(
    `/api/production/${params.id}/cost`,
  );
  const halal = useApiData<HalalVerdict>(`/api/production/${params.id}/halal`);
  const blockedByHalal = halal.data ? !halal.data.compliant : false;
  const role = useRole();
  const canComplete = role === 'admin' || role === 'production';

  const [lotCode, setLotCode] = useState('');
  const [laborHours, setLaborHours] = useState('0');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  async function complete() {
    setBusy(true);
    setMsg(null);
    try {
      const overriding = blockedByHalal && override;
      await api(`/api/production/${params.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          outputLotCode: lotCode,
          laborHours: Number(laborHours) || 0,
          ...(overriding ? { halalOverride: true, overrideReason } : {}),
        }),
      });
      setMsg({ kind: 'ok', text: 'Order completed. Output lot is in quarantine pending QC.' });
      setLotCode('');
      setOverride(false);
      setOverrideReason('');
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';
  const isOpen = c && (c.status === 'planned' || c.status === 'in_progress');
  const isCompleted = c?.status === 'completed';

  return (
    <Page>
      <PageHeader title="Production order cost">
        Material, labor, and overhead rolled up and frozen at completion.
      </PageHeader>

      <Link href="/app/production" className="text-[0.85rem] text-muted hover:text-text">
        ← All orders
      </Link>

      <div className="mt-4">
        {loading && !c ? (
          <p className={stateBox}>Loading…</p>
        ) : error && !c ? (
          <p className={stateBox}>Could not load — {error}</p>
        ) : !c ? (
          <p className={stateBox}>No cost data for this order.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <span className="mono text-[1.1rem]">{c.code}</span>
              <StatusBadge value={c.status} tones={PRODUCTION_STATUS_TONES} />
            </div>

            {isOpen && halal.data && <HalalVerdictPanel verdict={halal.data} />}

            {isCompleted ? (
              <>
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))]">
                  <Stat label="Material" value={money(c.materialCost)} />
                  <Stat
                    label="Labor"
                    value={c.laborCost == null ? '—' : money(c.laborCost)}
                    sub={c.laborHours > 0 ? `${c.laborHours} h` : undefined}
                  />
                  <Stat label="Overhead" value={c.overheadCost == null ? '—' : money(c.overheadCost)} />
                  <Stat label="Total cost" value={money(c.totalCost)} />
                  <Stat
                    label={`Unit cost / ${c.unit}`}
                    value={c.unitCost == null ? '—' : money(c.unitCost)}
                  />
                  <Stat label="Output quantity" value={`${c.outputQuantity} ${c.unit}`} />
                </div>

                {c.lines.length === 0 ? (
                  <p className="text-[0.9rem] text-muted">No consumptions recorded.</p>
                ) : (
                  <div>
                    <h2 className="section-label mb-[0.85rem]">Cost by material</h2>
                    <DataTable columns={lineColumns} rows={c.lines} rowKey={(l) => l.rawMaterialId} />
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
                  <Stat label="Output quantity" value={`${c.outputQuantity} ${c.unit}`} />
                </div>
                <p className="text-[0.9rem] text-muted">
                  Costs are rolled up and frozen when the order is completed.
                </p>

                {isOpen && canComplete && (
                  <div className="card flex max-w-lg flex-col gap-4">
                    <h2 className="section-label">Complete order</h2>
                    <p className="text-[0.82rem] text-muted">
                      Consumes components FEFO and produces the finished lot (into quarantine for QC).
                      Labor cost = hours × the standard rate; overhead is added per the costing rates.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="lotCode" className="label">
                        Output lot code
                      </label>
                      <input
                        id="lotCode"
                        className="input"
                        value={lotCode}
                        onChange={(e) => setLotCode(e.target.value)}
                        placeholder="e.g. FG-2406-001"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="laborHours" className="label">
                        Labor hours
                      </label>
                      <input
                        id="laborHours"
                        className="input w-40"
                        inputMode="decimal"
                        value={laborHours}
                        onChange={(e) => setLaborHours(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                    {blockedByHalal && role === 'admin' && (
                      <div className="flex flex-col gap-2 rounded border border-border-strong bg-surface p-3">
                        <label className="flex items-start gap-2 text-[0.85rem]">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={override}
                            onChange={(e) => setOverride(e.target.checked)}
                          />
                          <span>
                            Override the halal gate (admin). The decision is recorded — who, when, and
                            why — against this order.
                          </span>
                        </label>
                        {override && (
                          <input
                            className="input"
                            value={overrideReason}
                            onChange={(e) => setOverrideReason(e.target.value)}
                            placeholder="Reason for override (required, recorded)"
                          />
                        )}
                      </div>
                    )}
                    <div>
                      <button
                        className="btn btn-sm"
                        onClick={complete}
                        disabled={
                          busy ||
                          lotCode.trim().length === 0 ||
                          (blockedByHalal &&
                            !(role === 'admin' && override && overrideReason.trim().length > 0))
                        }
                      >
                        {busy
                          ? 'Completing…'
                          : blockedByHalal && override
                            ? 'Override & complete'
                            : 'Complete order'}
                      </button>
                    </div>
                    {blockedByHalal && role !== 'admin' && (
                      <p className="text-[0.82rem] text-bad">
                        Completion is blocked: this order&apos;s recipe isn&apos;t halal-compliant (see
                        the offending materials above).
                      </p>
                    )}
                    {msg && (
                      <p className={msg.kind === 'ok' ? 'text-[0.85rem] text-accent' : 'text-[0.85rem] text-bad'}>
                        {msg.text}
                      </p>
                    )}
                  </div>
                )}

                {msg && !(isOpen && canComplete) && (
                  <p className={msg.kind === 'ok' ? 'text-[0.85rem] text-accent' : 'text-[0.85rem] text-bad'}>
                    {msg.text}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

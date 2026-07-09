'use client';

import { useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { StatusBadge, HALAL_STATUS_TONES, COMPLIANCE_TONES } from '../../components/StatusBadge';
import { api, errMsg } from '@/lib/api-client';
import type {
  ComplianceOverview,
  MaterialHalal,
  HalalStatus,
} from '@/server/compliance';

const STATUS_LABELS: Record<HalalStatus, string> = {
  certified: 'Certified',
  not_certified: 'Not certified',
  in_review: 'In review',
};

interface Draft {
  halalStatus: HalalStatus;
  halalCertNumber: string;
  halalCertifier: string;
  halalCertExpiry: string;
}

const draftFrom = (m: MaterialHalal): Draft => ({
  halalStatus: m.halalStatus,
  halalCertNumber: m.halalCertNumber ?? '',
  halalCertifier: m.halalCertifier ?? '',
  halalCertExpiry: m.halalCertExpiry ?? '',
});

export default function HalalCompliancePage() {
  const { data, error, loading, reload } = useApiData<ComplianceOverview>('/api/admin/halal');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function startEdit(m: MaterialHalal) {
    setEditingId(m.id);
    setDraft(draftFrom(m));
    setMsg(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function save(materialId: string) {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/admin/halal', {
        method: 'PUT',
        body: JSON.stringify({
          materialId,
          halalStatus: draft.halalStatus,
          halalCertNumber: draft.halalCertNumber.trim() || null,
          halalCertifier: draft.halalCertifier.trim() || null,
          halalCertExpiry: draft.halalCertExpiry.trim() || null,
        }),
      });
      setMsg({ kind: 'ok', text: 'Halal status saved.' });
      cancelEdit();
      reload();
    } catch (e) {
      setMsg({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';
  const materials = data?.materials ?? [];
  const versions = data?.formulaVersions ?? [];
  const nonCompliant = versions.filter((v) => !v.compliant).length;

  return (
    <Page>
      <PageHeader title="Halal compliance">
        Record each raw material&rsquo;s halal certification. A formula version is compliant only when
        every component is certified with an unexpired certificate — the verdict below is derived from
        the materials, so it can never drift from the recipe. Certificate details are entered here and
        are not independently verified.
      </PageHeader>

      {msg && (
        <p className={msg.kind === 'ok' ? 'mt-3 text-[0.85rem] text-accent' : 'mt-3 text-[0.85rem] text-bad'}>
          {msg.text}
        </p>
      )}

      {/* ---------- materials ---------- */}
      <section className="mt-5">
        <h2 className="section-label">Raw material halal status</h2>
        {loading && !data ? (
          <p className={`mt-2 ${stateBox}`}>Loading…</p>
        ) : error && !data ? (
          <p className={`mt-2 ${stateBox}`}>Could not load — {error}</p>
        ) : materials.length === 0 ? (
          <p className={`mt-2 ${stateBox}`}>No raw materials yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <div className="w-full overflow-x-auto"><table className="w-full text-sm min-w-[38rem]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 pr-3 font-medium">SKU</th>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Certificate #</th>
                  <th className="py-2 pr-3 font-medium">Certifier</th>
                  <th className="py-2 pr-3 font-medium">Expiry</th>
                  <th className="py-2 pr-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const editing = editingId === m.id && draft;
                  if (editing) {
                    return (
                      <tr key={m.id} className="border-t border-border align-top">
                        <td className="py-2 pr-3 mono">{m.sku}</td>
                        <td className="py-2 pr-3">{m.name}</td>
                        <td className="py-2 pr-3">
                          <select
                            className="input"
                            value={draft.halalStatus}
                            onChange={(e) =>
                              setDraft({ ...draft, halalStatus: e.target.value as HalalStatus })
                            }
                          >
                            <option value="certified">Certified</option>
                            <option value="in_review">In review</option>
                            <option value="not_certified">Not certified</option>
                          </select>
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            className="input w-40"
                            value={draft.halalCertNumber}
                            onChange={(e) => setDraft({ ...draft, halalCertNumber: e.target.value })}
                            placeholder="e.g. MUI-12345"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            className="input w-36"
                            value={draft.halalCertifier}
                            onChange={(e) => setDraft({ ...draft, halalCertifier: e.target.value })}
                            placeholder="e.g. BPJPH"
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <input
                            type="date"
                            className="input w-40"
                            value={draft.halalCertExpiry}
                            onChange={(e) => setDraft({ ...draft, halalCertExpiry: e.target.value })}
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-2">
                            <button className="btn btn-sm" onClick={() => save(m.id)} disabled={busy}>
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                            <button className="btn btn-sm btn-ghost" onClick={cancelEdit} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={m.id} className="border-t border-border">
                      <td className="py-2 pr-3 mono">{m.sku}</td>
                      <td className="py-2 pr-3">{m.name}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge value={m.halalStatus} tones={HALAL_STATUS_TONES}>
                          {STATUS_LABELS[m.halalStatus]}
                        </StatusBadge>
                      </td>
                      <td className="py-2 pr-3 mono">{m.halalCertNumber ?? '—'}</td>
                      <td className="py-2 pr-3">{m.halalCertifier ?? '—'}</td>
                      <td className="py-2 pr-3 mono">{m.halalCertExpiry ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <button className="btn btn-sm btn-ghost" onClick={() => startEdit(m)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        )}
      </section>

      {/* ---------- formula compliance ---------- */}
      <section className="mt-8">
        <h2 className="section-label">
          Formula compliance
          {versions.length > 0 && (
            <span className="ml-2 text-[0.78rem] font-normal text-muted">
              {nonCompliant === 0
                ? `all ${versions.length} compliant`
                : `${nonCompliant} of ${versions.length} non-compliant`}
            </span>
          )}
        </h2>
        {data && versions.length === 0 ? (
          <p className={`mt-2 ${stateBox}`}>No formula versions yet.</p>
        ) : data ? (
          <div className="mt-2 overflow-x-auto">
            <div className="w-full overflow-x-auto"><table className="w-full text-sm min-w-[38rem]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 pr-3 font-medium">Formula</th>
                  <th className="py-2 pr-3 font-medium">Product</th>
                  <th className="py-2 pr-3 font-medium">Locked</th>
                  <th className="py-2 pr-3 font-medium">Verdict</th>
                  <th className="py-2 pr-3 font-medium">Non-compliant inputs</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.formulaVersionId} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <span className="mono">{v.formulaCode}</span>{' '}
                      <span className="text-muted">v{v.versionNo}</span>
                      <div className="text-[0.78rem] text-muted">{v.formulaName}</div>
                    </td>
                    <td className="py-2 pr-3">{v.productName ?? '—'}</td>
                    <td className="py-2 pr-3">{v.isLocked ? 'Yes' : 'No'}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge
                        value={v.compliant ? 'compliant' : 'non-compliant'}
                        tones={COMPLIANCE_TONES}
                      >
                        {v.compliant ? 'Compliant' : 'Non-compliant'}
                      </StatusBadge>
                    </td>
                    <td className="py-2 pr-3">
                      {v.offending.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {v.offending.map((o) => (
                            <li key={o.sku}>
                              <span className="mono">{o.sku}</span>{' '}
                              <span className="text-muted">— {o.reason}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        ) : null}
      </section>
    </Page>
  );
}

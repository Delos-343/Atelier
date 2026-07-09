'use client';

import { useCallback, useEffect, useState } from 'react';
import { RESOURCES, type FieldSpec, type ResourceConfig } from './resourceConfig';
import { api, errMsg } from '@/lib/api-client';

type Row = Record<string, unknown>;
type FormValues = Record<string, string | boolean>;

function blankValues(config: ResourceConfig): FormValues {
  const v: FormValues = {};
  for (const f of config.fields) v[f.name] = f.type === 'checkbox' ? false : '';
  return v;
}

function valuesFromRow(config: ResourceConfig, row: Row): FormValues {
  const v: FormValues = {};
  for (const f of config.fields) {
    const raw = row[f.name];
    v[f.name] = f.type === 'checkbox' ? Boolean(raw) : raw == null ? '' : String(raw);
  }
  return v;
}

function buildPayload(config: ResourceConfig, values: FormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of config.fields) {
    const v = values[f.name];
    if (f.type === 'checkbox') payload[f.name] = Boolean(v);
    else if (f.type === 'number') {
      if (v !== '' && v !== undefined) payload[f.name] = Number(v);
    } else {
      payload[f.name] = String(v ?? '').trim();
    }
  }
  return payload;
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  if (spec.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 py-1.5">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        <span className="text-[0.9rem]">{spec.label}</span>
      </label>
    );
  }
  return (
    <label className="block">
      <span className="label">
        {spec.label}
        {spec.required && <span className="text-bad"> *</span>}
      </span>
      {spec.type === 'select' ? (
        <select className="input" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Select…
          </option>
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          type={spec.type === 'number' ? 'number' : 'text'}
          inputMode={spec.type === 'number' ? 'decimal' : undefined}
          step={spec.step}
          placeholder={spec.placeholder}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {spec.help && <span className="mt-1 block text-[0.78rem] text-muted">{spec.help}</span>}
    </label>
  );
}

export function ResourceManager({ resource }: { resource: string }) {
  const config = RESOURCES[resource];

  const [rows, setRows] = useState<Row[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [values, setValues] = useState<FormValues>(() => (config ? blankValues(config) : {}));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!config) return;
    setListLoading(true);
    setListError(null);
    try {
      const data = await api<Row[]>(config.basePath);
      setRows(data ?? []);
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setListLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!config) return <p className="text-bad">Unknown resource: {resource}</p>;

  const openCreate = () => {
    setEditing(null);
    setValues(blankValues(config));
    setFormError(null);
    setFormOpen(true);
  };
  const openEdit = (row: Row) => {
    setEditing(row);
    setValues(valuesFromRow(config, row));
    setFormError(null);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = buildPayload(config, values);
      if (editing) {
        await api(`${config.basePath}/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api(config.basePath, { method: 'POST', body: JSON.stringify(payload) });
      }
      closeForm();
      await load();
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setListError(null);
    try {
      await api(`${config.basePath}/${id}`, { method: 'DELETE' });
      setConfirmId(null);
      await load();
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[0.85rem] text-muted">
          {listLoading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? config.label : config.labelPlural.toLowerCase()}`}
        </span>
        {!formOpen && (
          <button className="btn btn-sm" onClick={openCreate}>
            New {config.label}
          </button>
        )}
      </div>

      {formOpen && (
        <div className="card mb-5">
          <h2 className="mb-3 text-[1.05rem] font-semibold">
            {editing ? `Edit ${config.label}` : `New ${config.label}`}
          </h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
            {config.fields.map((f) => (
              <Field
                key={f.name}
                spec={f}
                value={values[f.name] ?? (f.type === 'checkbox' ? false : '')}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
              />
            ))}
          </div>
          {formError && (
            <p className="mt-3 rounded border border-bad bg-surface px-3 py-2 text-[0.85rem] text-bad">
              {formError}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button className="btn btn-sm" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : `Create ${config.label}`}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={closeForm} disabled={submitting}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {listError && (
        <p className="mb-4 rounded border border-bad bg-surface px-3 py-2 text-[0.85rem] text-bad">
          {listError}
        </p>
      )}

      {listLoading ? (
        <div className="rounded border border-dashed border-border-strong bg-surface p-6 text-muted">
          Loading {config.labelPlural.toLowerCase()}…
        </div>
      ) : listError ? null : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong bg-surface p-6 text-muted">
          No {config.labelPlural.toLowerCase()} yet. Create the first one above.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {config.columns.map((c) => (
                  <th key={c.key} className={c.align === 'right' ? 'ta-r' : undefined}>
                    {c.label}
                  </th>
                ))}
                <th className="ta-r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = String(row.id);
                return (
                  <tr key={id}>
                    {config.columns.map((c) => (
                      <td
                        key={c.key}
                        data-label={c.label}
                        className={c.align === 'right' ? 'ta-r' : undefined}
                      >
                        {c.render ? c.render(row[c.key], row) : dashCell(row[c.key])}
                      </td>
                    ))}
                    <td data-label="Actions" className="ta-r whitespace-nowrap">
                      {confirmId === id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-[0.82rem] text-muted">Delete?</span>
                          <button
                            className="btn btn-sm btn-bad"
                            onClick={() => void remove(id)}
                            disabled={busyId === id}
                          >
                            {busyId === id ? '…' : 'Confirm'}
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => setConfirmId(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <button className="btn btn-sm btn-ghost" onClick={() => openEdit(row)}>
                            Edit
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => setConfirmId(id)}>
                            Delete
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function dashCell(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

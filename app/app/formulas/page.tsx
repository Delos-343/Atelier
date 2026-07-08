'use client';

import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { AsyncView } from '../../components/offline/AsyncView';
import { DataTable, type Column } from '../../components/DataTable';

interface Version { id: string; version_no: number; basis: string; is_locked: boolean }
interface Formula { id: string; code: string; name: string; formula_versions: Version[] | null }

const columns: Column<Formula>[] = [
  { key: 'code', header: 'Code', render: (f) => <span className="mono">{f.code}</span> },
  { key: 'name', header: 'Name' },
  {
    key: 'versions',
    header: 'Versions',
    render: (f) => (
      <>
        {(f.formula_versions ?? []).map((v) => (
          <span key={v.id} className={`badge ${v.is_locked ? 'badge-ok' : ''}`}>
            v{v.version_no} · {v.basis}
            {v.is_locked ? ' · locked' : ''}
          </span>
        ))}
      </>
    ),
  },
];

export default function FormulasPage() {
  const state = useApiData<Formula[]>('/api/formulas');
  return (
    <Page>
      <PageHeader title="Formulas">
        Versioned bills of materials. Locked versions are immutable and safe to produce against.
      </PageHeader>
      <AsyncView state={state} empty="No formulas yet.">
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(f) => f.id} />}
      </AsyncView>
    </Page>
  );
}

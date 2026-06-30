'use client';

import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { AsyncView } from '../../components/offline/AsyncView';
import { DataTable, type Column } from '../../components/DataTable';
import { RecordQcForm } from '../../components/RecordQcForm';

interface Lot {
  id: string;
  lot_code: string;
  quantity_on_hand: string;
  unit: string;
}

export default function QcPage() {
  const state = useApiData<Lot[]>('/api/inventory?status=quarantine');

  const columns: Column<Lot>[] = [
    { key: 'lot_code', header: 'Lot', render: (l) => <span className="mono">{l.lot_code}</span> },
    { key: 'qty', header: 'Quantity', align: 'right', render: (l) => <span className="mono">{l.quantity_on_hand} {l.unit}</span> },
    { key: 'decision', header: 'Decision', render: (l) => <RecordQcForm lotId={l.id} onDone={state.reload} /> },
  ];

  return (
    <Page>
      <PageHeader title="Quality control">
        Finished lots are quarantined until released. Passing frees stock; rejecting holds it.
      </PageHeader>
      <AsyncView state={state} empty="Nothing awaiting QC.">
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(l) => l.id} />}
      </AsyncView>
    </Page>
  );
}

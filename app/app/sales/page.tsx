'use client';

import Link from 'next/link';
import { Page, PageHeader } from '../../components/Page';
import { useApiData } from '../../components/offline/useApiData';
import { AsyncView } from '../../components/offline/AsyncView';
import { DataTable, type Column } from '../../components/DataTable';
import { NewSalesOrderForm } from '../../components/NewSalesOrderForm';
import { useRole } from '../../components/auth/SessionProvider';
import { SALES_STATUS_CLASS } from './status';

interface SalesOrder {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  customerName: string;
}

const columns: Column<SalesOrder>[] = [
  {
    key: 'code',
    header: 'Code',
    render: (o) => (
      <Link href={`/app/sales/${o.id}`} className="mono text-accent hover:underline">
        {o.code}
      </Link>
    ),
  },
  { key: 'customer', header: 'Customer', render: (o) => o.customerName },
  {
    key: 'status',
    header: 'Status',
    render: (o) => <span className={`badge ${SALES_STATUS_CLASS[o.status] ?? ''}`}>{o.status}</span>,
  },
  { key: 'date', header: 'Date', align: 'right', render: (o) => <span className="mono">{o.orderDate}</span> },
];

export default function SalesPage() {
  const role = useRole();
  const state = useApiData<SalesOrder[]>('/api/sales');
  return (
    <Page>
      <PageHeader title="Sales">
        Customer orders. Expected margin previews each line against current finished-goods cost; realized
        margin is recorded at shipment.
      </PageHeader>

      {role === 'admin' && <NewSalesOrderForm onSubmitted={state.reload} />}

      <h2 className="section-label mb-[0.85rem] mt-9">Orders</h2>
      <AsyncView state={state} empty="No sales orders yet.">
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={(o) => o.id} />}
      </AsyncView>
    </Page>
  );
}

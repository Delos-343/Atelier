'use client';

import { useParams } from 'next/navigation';
import { useApiData } from '../../../components/offline/useApiData';
import { DocSheet, DocState } from '../../../components/print/DocSheet';
import type { PackingSlipDocument } from '@/server/documents';

const right = { textAlign: 'right' as const };

export default function PackingSlipPrintPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data, error, loading } = useApiData<PackingSlipDocument>(
    `/api/documents/packing-slip/${orderId}`,
  );

  if (loading && !data) return <DocState>Loading…</DocState>;
  if (error && !data) return <DocState>Could not load — {error}</DocState>;
  if (!data) return null;

  return (
    <DocSheet
      title="Packing Slip"
      number={data.number}
      date={data.date}
      status={data.status}
      party={data.customer}
      partyLabel="Ship to"
      warehouse={data.warehouse}
      pdfHref={`/api/documents/packing-slip/${orderId}?format=pdf`}
    >
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th style={right}>Ordered</th>
            <th style={right}>Shipped</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <span className="font-medium">{l.sku}</span>{' '}
                <span className="text-[#6b7280]">{l.name}</span>
              </td>
              <td style={right}>
                {l.ordered} {l.unit}
              </td>
              <td style={right}>
                {l.shipped} {l.unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-[0.78rem] text-[#6b7280]">
        Please check goods received against the shipped quantities above and report any discrepancy.
      </p>
    </DocSheet>
  );
}

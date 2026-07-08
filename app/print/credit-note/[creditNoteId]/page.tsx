'use client';

import { useParams } from 'next/navigation';
import { useApiData } from '../../../components/offline/useApiData';
import { DocSheet, DocState } from '../../../components/print/DocSheet';
import { money } from '@/lib/format';
import type { CreditNoteDocument } from '@/server/documents';

const right = { textAlign: 'right' as const };

export default function CreditNotePrintPage() {
  const { creditNoteId } = useParams<{ creditNoteId: string }>();
  const { data, error, loading } = useApiData<CreditNoteDocument>(
    `/api/documents/credit-note/${creditNoteId}`,
  );

  if (loading && !data) return <DocState>Loading…</DocState>;
  if (error && !data) return <DocState>Could not load — {error}</DocState>;
  if (!data) return null;

  return (
    <DocSheet
      title="Credit Note"
      number={data.number}
      date={data.date}
      orderCode={data.orderCode}
      party={data.customer}
      partyLabel="Credit to"
      pdfHref={`/api/documents/credit-note/${creditNoteId}?format=pdf`}
    >
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th style={right}>Qty</th>
            <th style={right}>Unit price</th>
            <th style={right}>Credit</th>
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
                {l.quantity} {l.unit}
              </td>
              <td style={right}>{money(l.unitPrice)}</td>
              <td style={right}>{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={right}>
              Total credited
            </td>
            <td style={right}>{money(data.total)}</td>
          </tr>
        </tfoot>
      </table>
    </DocSheet>
  );
}

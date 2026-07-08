'use client';

import { useParams } from 'next/navigation';
import { useApiData } from '../../../components/offline/useApiData';
import { DocSheet, DocState } from '../../../components/print/DocSheet';
import { money } from '@/lib/format';
import type { InvoiceDocument } from '@/server/documents';

const right = { textAlign: 'right' as const };

export default function InvoicePrintPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data, error, loading } = useApiData<InvoiceDocument>(`/api/documents/invoice/${orderId}`);

  if (loading && !data) return <DocState>Loading…</DocState>;
  if (error && !data) return <DocState>Could not load — {error}</DocState>;
  if (!data) return null;

  return (
    <DocSheet
      title="Invoice"
      number={data.number}
      date={data.date}
      dueDate={data.dueDate}
      status={data.status}
      party={data.customer}
      partyLabel="Bill to"
      warehouse={data.warehouse}
      pdfHref={`/api/documents/invoice/${orderId}?format=pdf`}
    >
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th style={right}>Qty</th>
            <th style={right}>Unit price</th>
            <th style={right}>Amount</th>
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
          {data.subtotal === undefined ? (
            <tr>
              <td colSpan={3} style={right}>
                Total
              </td>
              <td style={right}>{money(data.total)}</td>
            </tr>
          ) : (
            <>
              <tr>
                <td colSpan={3} style={right}>
                  Subtotal
                </td>
                <td style={right}>{money(data.subtotal)}</td>
              </tr>
              {(data.discountAmount ?? 0) > 0 && (
                <>
                  <tr>
                    <td colSpan={3} style={right}>
                      Discount ({Number(data.discountPct ?? 0)}%)
                    </td>
                    <td style={right}>−{money(data.discountAmount ?? 0)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} style={right}>
                      Taxable
                    </td>
                    <td style={right}>{money(data.taxableAmount ?? data.subtotal)}</td>
                  </tr>
                </>
              )}
              <tr>
                <td colSpan={3} style={right}>
                  PPN ({Number(data.taxRate ?? 0)}%)
                </td>
                <td style={right}>{money(data.taxAmount ?? 0)}</td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={3} style={right}>
                  Total
                </td>
                <td style={right}>{money(data.total)}</td>
              </tr>
            </>
          )}
        </tfoot>
      </table>
    </DocSheet>
  );
}

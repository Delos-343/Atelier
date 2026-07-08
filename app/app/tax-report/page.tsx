'use client';

import { useState } from 'react';
import { Page, PageHeader } from '../../components/Page';
import { Stat } from '../../components/Stat';
import { useApiData } from '../../components/offline/useApiData';
import { money } from '@/lib/format';
import { toCsv } from '@/lib/csv';
import type { TaxReport, TaxReportLine } from '@/server/taxReport';

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthBounds(year: number, month: number) {
  return { start: iso(new Date(year, month, 1)), end: iso(new Date(year, month + 1, 0)) };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function FakturTable({ title, partyLabel, lines }: { title: string; partyLabel: string; lines: TaxReportLine[] }) {
  const base = lines.reduce((s, l) => s + l.taxableBase, 0);
  const tax = lines.reduce((s, l) => s + l.taxAmount, 0);
  return (
    <section className="card overflow-x-auto">
      <h3 className="section-label">{title}</h3>
      {lines.length === 0 ? (
        <p className="mt-2 text-muted text-[0.85rem]">No documents in this period.</p>
      ) : (
        <table className="mt-2 w-full text-[0.85rem]">
          <thead>
            <tr className="text-muted text-[0.72rem] uppercase tracking-[0.06em]">
              <th className="py-1 text-left font-medium">Document</th>
              <th className="py-1 text-left font-medium">Date</th>
              <th className="py-1 text-left font-medium">{partyLabel}</th>
              <th className="py-1 text-left font-medium">NPWP</th>
              <th className="py-1 text-right font-medium">Base</th>
              <th className="py-1 text-right font-medium">PPN</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-[var(--border)]">
                <td className="py-1 mono">{l.documentNumber}</td>
                <td className="py-1">{l.docDate.slice(0, 10)}</td>
                <td className="py-1">{l.partyName}</td>
                <td className="py-1 mono text-[0.8rem]">{l.partyTaxId ?? '—'}</td>
                <td className="py-1 text-right mono">{money(l.taxableBase)}</td>
                <td className="py-1 text-right mono">{money(l.taxAmount)}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--border)] font-semibold">
              <td className="py-1" colSpan={4}>
                Total
              </td>
              <td className="py-1 text-right mono">{money(base)}</td>
              <td className="py-1 text-right mono">{money(tax)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function TaxReportPage() {
  const now = new Date();
  const thisMonth = monthBounds(now.getFullYear(), now.getMonth());
  const [start, setStart] = useState(thisMonth.start);
  const [end, setEnd] = useState(thisMonth.end);

  const report = useApiData<TaxReport>(`/api/tax-report?start=${start}&end=${end}`);
  const d = report.data;

  const linesRes = useApiData<TaxReportLine[]>(`/api/tax-report/lines?start=${start}&end=${end}`);
  const allLines = linesRes.data ?? [];
  const outputLines = allLines.filter((l) => l.side === 'output');
  const inputLines = allLines.filter((l) => l.side === 'input');

  function exportCsv() {
    const csv = toCsv(
      ['Side', 'Document', 'Date', 'Party code', 'Party', 'NPWP', 'Taxable base', 'PPN'],
      allLines.map((l) => [
        l.side === 'output' ? 'Output (sales)' : 'Input (purchases)',
        l.documentNumber,
        l.docDate.slice(0, 10),
        l.partyCode,
        l.partyName,
        l.partyTaxId ?? '',
        l.taxableBase,
        l.taxAmount,
      ]),
    );
    // Prepend a BOM so spreadsheets read UTF-8 correctly (matching the documents export).
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ppn-faktur-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function setMonth(offset: number) {
    const b = monthBounds(now.getFullYear(), now.getMonth() + offset);
    setStart(b.start);
    setEnd(b.end);
  }
  function setQuarter() {
    const q = Math.floor(now.getMonth() / 3);
    setStart(iso(new Date(now.getFullYear(), q * 3, 1)));
    setEnd(iso(new Date(now.getFullYear(), q * 3 + 3, 0)));
  }
  function setYear() {
    setStart(`${now.getFullYear()}-01-01`);
    setEnd(`${now.getFullYear()}-12-31`);
  }

  const net = d?.netPayable ?? 0;

  return (
    <Page>
      <PageHeader title="Tax report">
        <span className="text-muted">Output-vs-input PPN for a period.</span>
      </PageHeader>

      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">From</span>
            <input className="input w-40" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input className="input w-40" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(0)}>
              This month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(-1)}>
              Last month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setQuarter}>
              This quarter
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setYear}>
              This year
            </button>
          </div>
        </div>
        {report.error && <p className="mt-2 text-[0.85rem] text-bad">{report.error}</p>}
      </div>

      {d && (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Output PPN (keluaran)" value={money(d.outputTax)} />
            <Stat label="Input PPN (masukan)" value={money(d.inputTax)} />
            <Stat label={net >= 0 ? 'PPN payable' : 'PPN credit'} value={money(Math.abs(net))} />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="card">
              <h2 className="section-label">Output — sales</h2>
              <dl className="mt-2 space-y-1 text-[0.9rem]">
                <Row label="PPN charged" value={money(d.outputTax)} />
                <Row label="Taxable sales" value={money(d.taxableSales)} />
                <Row label="Invoices" value={String(d.invoiceCount)} />
              </dl>
            </section>
            <section className="card">
              <h2 className="section-label">Input — purchases</h2>
              <dl className="mt-2 space-y-1 text-[0.9rem]">
                <Row label="PPN paid" value={money(d.inputTax)} />
                <Row label="Taxable purchases" value={money(d.taxablePurchases)} />
                <Row label="Bills" value={String(d.billCount)} />
              </dl>
            </section>
          </div>

          <p className="mt-3 text-[0.82rem] text-muted">
            {net >= 0
              ? `Net PPN of ${money(net)} is owed to the tax office for this period.`
              : `Net input PPN of ${money(-net)} carries as a credit to the next period.`}{' '}
            Output tax is the PPN on issued invoices; credit notes are untaxed, and tax-exempt sales
            appear in the taxable-sales base at zero tax.
          </p>

          {allLines.length > 0 && (
            <section className="mt-6">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="section-label">Faktur Pajak detail</h2>
                <button type="button" className="btn btn-sm btn-ghost" onClick={exportCsv}>
                  Export CSV
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <FakturTable title="Output — sales (keluaran)" partyLabel="Customer" lines={outputLines} />
                <FakturTable title="Input — purchases (masukan)" partyLabel="Supplier" lines={inputLines} />
              </div>
              <p className="mt-3 text-[0.8rem] text-muted">
                Every taxed document behind the totals above — the lines sum back to the report exactly.
                Export as CSV to reconcile or re-key into a PPN filing.
              </p>
            </section>
          )}
        </>
      )}
    </Page>
  );
}

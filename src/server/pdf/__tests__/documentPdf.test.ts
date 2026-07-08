import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  invoiceToSpec,
  packingSlipToSpec,
  creditNoteToSpec,
  composeDocumentPdf,
  renderInvoicePdf,
  renderPackingSlipPdf,
  renderCreditNotePdf,
  renderIssuedPdf,
  statementToSpec,
  renderStatementPdf,
  type StatementPdfData,
  ledgerToSpec,
  renderLedgerPdf,
  type LedgerPdfData,
  pdfFilename,
} from '../documentPdf';
import type {
  InvoiceDocument,
  PackingSlipDocument,
  CreditNoteDocument,
} from '@/server/documents';

const customer = {
  code: 'ACME',
  name: 'Acme Perfumery',
  email: 'buyer@acme.test',
  phone: null,
  address: '12 Rose St',
};

const invoice: InvoiceDocument = {
  kind: 'invoice',
  number: 'SO-2026-001',
  date: '2026-02-02',
  status: 'partially_shipped',
  customer,
  warehouse: { code: 'WH1', name: 'Main Warehouse' },
  lines: [
    { sku: 'ROSE-EDT', name: 'Rose EDT', quantity: 3, unit: 'ml', unitPrice: 25, lineTotal: 75 },
    { sku: 'OUD-XT', name: 'Oud Extract', quantity: 2, unit: 'ml', unitPrice: 10, lineTotal: 20 },
  ],
  total: 95,
};

const packingSlip: PackingSlipDocument = {
  kind: 'packing-slip',
  number: 'SO-2026-001',
  date: '2026-02-02',
  status: 'partially_shipped',
  customer,
  warehouse: { code: 'WH1', name: 'Main Warehouse' },
  lines: [{ sku: 'ROSE-EDT', name: 'Rose EDT', ordered: 3, shipped: 2, unit: 'ml' }],
};

const creditNote: CreditNoteDocument = {
  kind: 'credit-note',
  number: 'CN-2026-004',
  date: '2026-03-04',
  orderCode: 'SO-2026-001',
  customer,
  lines: [{ sku: 'ROSE-EDT', name: 'Rose EDT', quantity: 1, unit: 'ml', unitPrice: 25, lineTotal: 25 }],
  total: 25,
};

const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.slice(0, 5)).toString('latin1') === '%PDF-';

describe('document PDF adapters', () => {
  it('maps an invoice to a priced, totalled spec', () => {
    const spec = invoiceToSpec(invoice);
    expect(spec.title).toBe('Invoice');
    expect(spec.partyLabel).toBe('Bill to');
    expect(spec.party.name).toBe('Acme Perfumery');
    expect(spec.warehouse?.code).toBe('WH1');
    expect(spec.columns.map((c) => c.header)).toEqual(['Product', 'Qty', 'Unit price', 'Amount']);
    // column widths cover the content area exactly
    expect(spec.columns.reduce((s, c) => s + c.width, 0)).toBeCloseTo(495, 0);
    expect(spec.rows).toHaveLength(2);
    expect(spec.rows[0][1]).toBe('3 ml');
    expect(spec.total?.value).toBe(invoice.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    // A pre-tax snapshot (no tax fields) shows a single total, no breakdown.
    expect(spec.summary).toBeUndefined();
  });

  it('builds a subtotal → discount → taxable → PPN → total breakdown for a taxed invoice', () => {
    const taxed: InvoiceDocument = {
      ...invoice,
      lines: [{ sku: 'ROSE-EDT', name: 'Rose EDT', quantity: 4, unit: 'ml', unitPrice: 25, lineTotal: 100 }],
      subtotal: 100,
      discountPct: 10,
      discountAmount: 10,
      taxableAmount: 90,
      taxRate: 11,
      taxAmount: 9.9,
      total: 99.9,
    };
    const summary = invoiceToSpec(taxed).summary!;
    expect(summary.map((r) => r.label)).toEqual(['Subtotal', 'Discount (10%)', 'Taxable', 'PPN (11%)', 'Total']);
    // The discount reads as a deduction and the total is the emphasised line.
    expect(summary.find((r) => r.label === 'Discount (10%)')!.value.startsWith('-')).toBe(true);
    expect(summary.find((r) => r.label === 'Total')!.strong).toBe(true);
  });

  it('omits the discount and taxable rows when the customer has no discount', () => {
    const taxed: InvoiceDocument = {
      ...invoice,
      subtotal: 95,
      discountPct: 0,
      discountAmount: 0,
      taxableAmount: 95,
      taxRate: 11,
      taxAmount: 10.45,
      total: 105.45,
    };
    expect(invoiceToSpec(taxed).summary!.map((r) => r.label)).toEqual(['Subtotal', 'PPN (11%)', 'Total']);
  });

  it('maps a packing slip with no prices and a note', () => {
    const spec = packingSlipToSpec(packingSlip);
    expect(spec.title).toBe('Packing Slip');
    expect(spec.partyLabel).toBe('Ship to');
    expect(spec.columns.map((c) => c.header)).toEqual(['Product', 'Ordered', 'Shipped']);
    expect(spec.total).toBeUndefined();
    expect(spec.note).toMatch(/discrepancy/i);
    expect(spec.rows[0]).toEqual(['ROSE-EDT   Rose EDT', '3 ml', '2 ml']);
  });

  it('maps a credit note with the source order in the meta', () => {
    const spec = creditNoteToSpec(creditNote);
    expect(spec.title).toBe('Credit Note');
    expect(spec.partyLabel).toBe('Credit to');
    expect(spec.metaRight.find((m) => m.label === 'Order')?.value).toBe('SO-2026-001');
    expect(spec.total?.label).toBe('Total credited');
  });

  it('carries the replaced identifiers of an ISSUED snapshot as reference meta lines', () => {
    // A live document has no orderCode/sourceCode — no reference line is added.
    expect(invoiceToSpec(invoice).metaRight.map((m) => m.label)).toEqual(['No.', 'Date', 'Status']);
    expect(creditNoteToSpec(creditNote).metaRight.map((m) => m.label)).toEqual(['No.', 'Date', 'Order']);

    // An issued snapshot carries the series number as `number` and the code it
    // replaced as orderCode / sourceCode; the paper keeps both.
    const issuedInv = invoiceToSpec({ ...invoice, number: 'INV-2026-00007', orderCode: 'SO-2026-001' });
    expect(issuedInv.metaRight.map((m) => `${m.label} ${m.value}`)).toEqual([
      'No. INV-2026-00007',
      'Order SO-2026-001',
      'Date 2026-02-02',
      'Status partially shipped',
    ]);

    const issuedPs = packingSlipToSpec({ ...packingSlip, number: 'PS-2026-00002', orderCode: 'SO-2026-001' });
    expect(issuedPs.metaRight.find((m) => m.label === 'Order')?.value).toBe('SO-2026-001');
    expect(issuedPs.metaRight.find((m) => m.label === 'No.')?.value).toBe('PS-2026-00002');

    const issuedCn = creditNoteToSpec({ ...creditNote, number: 'CN-2026-00001', sourceCode: 'CN-2026-004' });
    expect(issuedCn.metaRight.map((m) => `${m.label} ${m.value}`)).toEqual([
      'No. CN-2026-00001',
      'Ref CN-2026-004',
      'Date 2026-03-04',
      'Order SO-2026-001',
    ]);
  });
});

describe('document PDF composer', () => {
  it('renders each document to valid, non-trivial PDF bytes', async () => {
    const inv = await renderInvoicePdf(invoice);
    const pack = await renderPackingSlipPdf(packingSlip);
    const credit = await renderCreditNotePdf(creditNote);

    for (const bytes of [inv, pack, credit]) {
      expect(isPdf(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(1000);
    }

    // Leave samples for out-of-band inspection (pdftotext); harmless temp artifacts.
    writeFileSync(join(tmpdir(), 'atelier-sample-invoice.pdf'), inv);
    writeFileSync(join(tmpdir(), 'atelier-sample-packing.pdf'), pack);
    writeFileSync(join(tmpdir(), 'atelier-sample-credit.pdf'), credit);
  });

  it('renders the tax breakdown block on a taxed invoice', async () => {
    // Exercises the summary-rendering branch (subtotal / discount / taxable / PPN /
    // total) end-to-end, not just its construction.
    const taxed: InvoiceDocument = {
      ...invoice,
      subtotal: 95,
      discountPct: 5,
      discountAmount: 4.75,
      taxableAmount: 90.25,
      taxRate: 11,
      taxAmount: 9.93,
      total: 100.18,
    };
    const bytes = await renderInvoicePdf(taxed);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('stamps a VOID watermark onto an issued document when asked', async () => {
    // renderIssuedPdf takes a frozen snapshot (kind + snapshot); with the watermark
    // option it overlays the mark. The marked PDF is still valid and, because it
    // carries an extra drawn string, larger than the unmarked one.
    const snapshot = { ...invoice, number: 'INV-2026-00009', orderCode: 'SO-2026-001' };
    const plain = await renderIssuedPdf('invoice', snapshot);
    const voided = await renderIssuedPdf('invoice', snapshot, { watermark: 'VOID' });
    expect(isPdf(plain)).toBe(true);
    expect(isPdf(voided)).toBe(true);
    expect(voided.length).toBeGreaterThan(plain.length);

    // an unknown kind is a programming error, surfaced as a throw
    await expect(renderIssuedPdf('mystery', snapshot)).rejects.toThrow(/unknown document kind/i);
  });

  it('does not throw on empty lines or a missing warehouse', async () => {
    const bytes = await composeDocumentPdf({
      title: 'Invoice',
      metaRight: [{ label: 'No.', value: 'SO-X' }],
      partyLabel: 'Bill to',
      party: { code: 'C', name: 'C', email: null, phone: null, address: null },
      warehouse: null,
      columns: [
        { header: 'Product', align: 'left', width: 405 },
        { header: 'Amount', align: 'right', width: 90 },
      ],
      rows: [],
      total: { label: 'Total', value: '0.00' },
    });
    expect(isPdf(bytes)).toBe(true);
  });

  it('maps a customer statement to an aged, totalled spec and renders it', async () => {
    const data: StatementPdfData = {
      party: { code: 'CUST-1', name: 'Acme Perfumery', email: null, phone: null, address: null },
      asOf: '2026-07-01',
      invoices: [
        { documentNumber: 'INV-2026-00001', issuedAt: '2026-05-01', dueDate: '2026-05-31', daysOverdue: 31, open: 120 },
        { documentNumber: 'INV-2026-00002', issuedAt: '2026-06-20', dueDate: '2026-07-20', daysOverdue: -19, open: 80 },
      ],
      buckets: { current: 80, d1_30: 0, d31_60: 120, d61_90: 0, d90_plus: 0 },
      outstanding: 200,
    };
    const spec = statementToSpec(data);
    expect(spec.title).toBe('Statement');
    expect(spec.partyLabel).toBe('Account');
    expect(spec.columns.map((c) => c.header)).toEqual(['Invoice', 'Issued', 'Due', 'Overdue', 'Balance']);
    expect(spec.columns.reduce((s, c) => s + c.width, 0)).toBeCloseTo(495, 0);
    expect(spec.rows).toHaveLength(2);
    expect(spec.rows[0][3]).toBe('31d'); // overdue days
    expect(spec.rows[1][3]).toBe('—'); // not yet due
    expect(spec.total?.value).toBe('200.00');
    expect(spec.note).toContain('31–60 120.00');
    expect(isPdf(await renderStatementPdf(data))).toBe(true);
  });

  it('maps a running-account ledger to a balance-forward spec and renders it', async () => {
    const data: LedgerPdfData = {
      party: { code: 'CUST-1', name: 'Acme Perfumery', email: null, phone: null, address: null },
      start: '2026-07-01',
      end: '2026-07-31',
      closingBalance: 800,
      entries: [
        { date: '2026-07-01', type: 'opening', reference: null, debit: null, credit: null, balance: 600 },
        { date: '2026-07-05', type: 'invoice', reference: 'INV-2026-00002', debit: 500, credit: null, balance: 1100 },
        { date: '2026-07-10', type: 'credit_note', reference: 'CN-2026-00001', debit: null, credit: 100, balance: 1000 },
        { date: '2026-07-15', type: 'receipt', reference: 'bank', debit: null, credit: 200, balance: 800 },
      ],
    };
    const spec = ledgerToSpec(data);
    expect(spec.title).toBe('Statement of Account');
    expect(spec.partyLabel).toBe('Account');
    expect(spec.columns.map((c) => c.header)).toEqual(['Date', 'Detail', 'Charges', 'Payments', 'Balance']);
    expect(spec.columns.reduce((s, c) => s + c.width, 0)).toBeCloseTo(495, 0);
    expect(spec.rows).toHaveLength(4);
    expect(spec.rows[0][0]).toBe(''); // opening row has no date
    expect(spec.rows[0][1]).toBe('Balance brought forward');
    expect(spec.rows[0][2]).toBe(''); // and no charge
    expect(spec.rows[1][2]).toBe('500.00'); // invoice is a charge
    expect(spec.rows[2][3]).toBe('100.00'); // credit note is a payment-side reduction
    expect(spec.rows[3][1]).toBe('Receipt bank'); // receipt labelled with its reference
    expect(spec.total?.value).toBe('800.00');
    expect(isPdf(await renderLedgerPdf(data))).toBe(true);
  });

  it('notes an empty ledger carrying just an opening row', () => {
    const spec = ledgerToSpec({
      party: { code: 'C', name: 'C', email: null, phone: null, address: null },
      start: '2026-07-01',
      end: '2026-07-31',
      closingBalance: 0,
      entries: [{ date: '2026-07-01', type: 'opening', reference: null, debit: null, credit: null, balance: 0 }],
    });
    expect(spec.rows).toHaveLength(1);
    expect(spec.note).toContain('No account activity');
    expect(spec.total?.value).toBe('0.00');
  });
});

describe('pdfFilename', () => {
  it('sanitizes a document code into a safe filename', () => {
    expect(pdfFilename('Invoice', 'SO-2026-001')).toBe('Invoice-SO-2026-001.pdf');
    expect(pdfFilename('CreditNote', 'CN/2026 004')).toBe('CreditNote-CN-2026-004.pdf');
    expect(pdfFilename('Invoice', '')).toBe('Invoice-document.pdf');
  });
});

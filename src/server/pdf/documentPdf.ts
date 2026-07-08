import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import { money } from '@/lib/format';
import { BRAND_MARK_PNG_BASE64 } from './brandMark';
import type {
  DocumentParty,
  DocumentWarehouse,
  InvoiceDocument,
  PackingSlipDocument,
  CreditNoteDocument,
} from '@/server/documents';

/**
 * Server-side PDF for the three customer documents. pdf-lib is pure JS (browser-safe,
 * no filesystem or native font files), so it bundles and runs cleanly in the Next server
 * runtime — unlike pdfkit, which loads .afm metrics from disk. Each document maps to one
 * generic spec (letterhead, party, a column/row table, an optional total) that mirrors the
 * on-screen /print sheet, and a single composer draws it. The layout uses the standard-14
 * Helvetica family, so nothing needs embedding.
 */

type Align = 'left' | 'right';

interface PdfColumn {
  header: string;
  align: Align;
  width: number; // points; the widths of a document's columns sum to the content width
}

export interface DocumentPdfSpec {
  title: string;
  metaRight: { label: string; value: string }[];
  partyLabel: string;
  party: DocumentParty;
  warehouse?: DocumentWarehouse | null;
  columns: PdfColumn[];
  rows: string[][];
  total?: { label: string; value: string };
  /**
   * A right-aligned stack of money lines (subtotal, discount, tax, …) shown instead of
   * a single total. The last line is drawn strong as the grand total. When present it
   * takes precedence over `total`.
   */
  summary?: { label: string; value: string; strong?: boolean }[];
  note?: string;
  /** Diagonal stamp across the page (e.g. "VOID") — drawn under nothing, over everything. */
  watermark?: string;
}

// ── A4 geometry ──────────────────────────────────────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2; // 495.28

const INK = rgb(0.1, 0.1, 0.1);
const SOFT = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.86, 0.88);
const HEAVY = rgb(0.07, 0.09, 0.11);

/** Trim a string with an ellipsis until it fits within maxWidth at the given size. */
function fit(font: PDFFont, str: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(str, size) <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

/** A thin cursor over one page: y descends from the top; drawText baselines at `y`. */
class Cursor {
  y = MARGIN;
  constructor(
    private readonly page: PDFPage,
    private readonly helv: PDFFont,
    private readonly bold: PDFFont,
  ) {}

  private draw(str: string, x: number, size: number, font: PDFFont, color = INK) {
    this.page.drawText(str, { x, y: PAGE_H - this.y, size, font, color });
  }

  left(str: string, x: number, size: number, opts?: { bold?: boolean; color?: ReturnType<typeof rgb> }) {
    this.draw(str, x, size, opts?.bold ? this.bold : this.helv, opts?.color);
  }

  /** Draw right-aligned so the text ends at xRight. */
  right(str: string, xRight: number, size: number, opts?: { bold?: boolean; color?: ReturnType<typeof rgb> }) {
    const font = opts?.bold ? this.bold : this.helv;
    this.draw(str, xRight - font.widthOfTextAtSize(str, size), size, font, opts?.color);
  }

  rule(color = RULE, thickness = 1) {
    this.page.drawLine({
      start: { x: MARGIN, y: PAGE_H - this.y },
      end: { x: MARGIN + CONTENT_W, y: PAGE_H - this.y },
      thickness,
      color,
    });
  }

  down(by: number) {
    this.y += by;
  }

  get font() {
    return { helv: this.helv, bold: this.bold };
  }
}

/** Draw the shared table (column headers + rows) at the cursor, advancing it. */
function drawTable(cur: Cursor, columns: PdfColumn[], rows: string[][]) {
  const { helv, bold } = cur.font;
  const pad = 4;

  // column left edges
  const xs: number[] = [];
  let acc = MARGIN;
  for (const c of columns) {
    xs.push(acc);
    acc += c.width;
  }

  // header
  columns.forEach((c, i) => {
    const label = c.header.toUpperCase();
    if (c.align === 'right') cur.right(label, xs[i] + c.width - pad, 8, { bold: true, color: SOFT });
    else cur.left(label, xs[i] + pad, 8, { bold: true, color: SOFT });
  });
  cur.down(6);
  cur.rule(HEAVY, 1.2);
  cur.down(14);

  // rows
  for (const row of rows) {
    columns.forEach((c, i) => {
      const maxW = c.width - pad * 2;
      const cell = fit(c.align === 'right' ? bold : helv, row[i] ?? '', 9, maxW);
      if (c.align === 'right') cur.right(cell, xs[i] + c.width - pad, 9);
      else cur.left(cell, xs[i] + pad, 9);
    });
    cur.down(6);
    cur.rule(RULE, 0.75);
    cur.down(14);
  }
}

/** Compose a document PDF from its spec. Returns the encoded PDF bytes. */
function drawWatermark(page: PDFPage, font: PDFFont, text: string) {
  // Large, light, diagonal, centered: unmistakable on screen and on paper, without
  // obliterating the figures underneath. Geometry: rotate about the text origin,
  // so offset the start point by half the rotated text extents from the center.
  const size = 120;
  const angleDeg = 35;
  const rad = (angleDeg * Math.PI) / 180;
  const w = font.widthOfTextAtSize(text, size);
  const h = font.heightAtSize(size);
  const cx = PAGE_W / 2;
  const cy = PAGE_H / 2;
  page.drawText(text, {
    x: cx - (w / 2) * Math.cos(rad) + (h / 2.8) * Math.sin(rad),
    y: cy - (w / 2) * Math.sin(rad) - (h / 2.8) * Math.cos(rad),
    size,
    font,
    color: rgb(0.78, 0.25, 0.22),
    opacity: 0.16,
    rotate: degrees(angleDeg),
  });
}

export async function composeDocumentPdf(spec: DocumentPdfSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${spec.title} ${spec.metaRight[0]?.value ?? ''}`.trim());
  pdf.setAuthor('TechnicoFlor');
  pdf.setCreator('TechnicoFlor — Perfume ERP');

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const cur = new Cursor(page, helv, bold);
  const rightEdge = MARGIN + CONTENT_W;

  // ── letterhead: leaf mark + wordmark ──
  cur.down(18);
  let wordmarkX = MARGIN;
  try {
    const mark = await pdf.embedPng(Buffer.from(BRAND_MARK_PNG_BASE64, 'base64'));
    const mh = 22;
    const mw = (mark.width / mark.height) * mh;
    page.drawImage(mark, { x: MARGIN, y: PAGE_H - cur.y - 5, width: mw, height: mh });
    wordmarkX = MARGIN + mw + 8;
  } catch {
    wordmarkX = MARGIN; // fall back to a text-only letterhead if the mark can't embed
  }
  cur.left('TechnicoFlor', wordmarkX, 16, { bold: true });
  cur.right(spec.title.toUpperCase(), rightEdge, 15, { bold: true });
  cur.down(14);
  cur.left('Perfume Manufacturing & Distribution', MARGIN, 8.5, { color: SOFT });

  // meta lines (right column), stacked under the title
  for (const m of spec.metaRight) {
    cur.right(`${m.label}  ${m.value}`, rightEdge, 9, { color: INK });
    cur.down(13);
  }
  cur.down(10);
  cur.rule(RULE, 1);
  cur.down(24);

  // ── party block (+ optional warehouse on the right) ──
  const partyTop = cur.y;
  cur.left(spec.partyLabel.toUpperCase(), MARGIN, 8, { bold: true, color: SOFT });
  cur.down(14);
  cur.left(spec.party.name, MARGIN, 10.5, { bold: true });
  cur.down(13);
  cur.left(spec.party.code, MARGIN, 9, { color: SOFT });
  for (const extra of [spec.party.address, spec.party.email, spec.party.phone]) {
    if (extra) {
      cur.down(12);
      cur.left(extra, MARGIN, 9, { color: SOFT });
    }
  }

  if (spec.warehouse) {
    const save = cur.y;
    cur.y = partyTop;
    cur.right('DISPATCHED FROM', rightEdge, 8, { bold: true, color: SOFT });
    cur.down(14);
    cur.right(spec.warehouse.name, rightEdge, 10.5, { bold: true });
    cur.down(13);
    cur.right(spec.warehouse.code, rightEdge, 9, { color: SOFT });
    cur.y = Math.max(save, cur.y);
  }

  cur.down(34);

  // ── line table ──
  drawTable(cur, spec.columns, spec.rows);

  // ── totals ──
  if (spec.summary && spec.summary.length > 0) {
    cur.down(4);
    const labelX = MARGIN + spec.columns[0].width;
    spec.summary.forEach((row, i) => {
      if (row.strong && i > 0) {
        cur.down(2);
        cur.rule(RULE, 0.75);
        cur.down(6);
      }
      cur.left(row.label, labelX, 10, { bold: !!row.strong, color: row.strong ? INK : SOFT });
      cur.right(row.value, rightEdge - 4, 10, { bold: !!row.strong });
      cur.down(row.strong ? 10 : 13);
    });
    cur.rule(HEAVY, 1.2);
  } else if (spec.total) {
    cur.down(4);
    cur.left(spec.total.label, MARGIN + spec.columns[0].width, 10, { bold: true });
    cur.right(spec.total.value, rightEdge - 4, 10, { bold: true });
    cur.down(10);
    cur.rule(HEAVY, 1.2);
  }

  // ── note + footer ──
  if (spec.note) {
    cur.down(24);
    cur.left(fit(helv, spec.note, 8.5, CONTENT_W), MARGIN, 8.5, { color: SOFT });
  }

  cur.y = PAGE_H - MARGIN;
  cur.rule(RULE, 0.75);
  cur.down(12);
  cur.left('Generated by TechnicoFlor — reflects recorded order data at time of printing.', MARGIN, 8, {
    color: SOFT,
  });

  if (spec.watermark) drawWatermark(page, bold, spec.watermark);

  return pdf.save();
}

// ── adapters: each document DTO → the generic spec ───────────────────────────
const skuName = (sku: string, name: string) => (name ? `${sku}   ${name}` : sku);

/** The money-breakdown stack for an invoice, or undefined for a pre-v0.40.0 snapshot (→ single total). */
function invoiceSummary(d: InvoiceDocument): DocumentPdfSpec['summary'] {
  if (d.subtotal === undefined) return undefined;
  const rows: NonNullable<DocumentPdfSpec['summary']> = [{ label: 'Subtotal', value: money(d.subtotal) }];
  if ((d.discountAmount ?? 0) > 0) {
    // ASCII hyphen, not a Unicode minus (U+2212) — the standard PDF font is WinAnsi
    // and cannot encode U+2212, which would throw when rendering a discounted invoice.
    rows.push({ label: `Discount (${Number(d.discountPct ?? 0)}%)`, value: `-${money(d.discountAmount ?? 0)}` });
    rows.push({ label: 'Taxable', value: money(d.taxableAmount ?? d.subtotal) });
  }
  rows.push({ label: `PPN (${Number(d.taxRate ?? 0)}%)`, value: money(d.taxAmount ?? 0) });
  rows.push({ label: 'Total', value: money(d.total), strong: true });
  return rows;
}

export function invoiceToSpec(d: InvoiceDocument): DocumentPdfSpec {
  return {
    title: 'Invoice',
    metaRight: [
      { label: 'No.', value: d.number },
      // On an issued snapshot the series number replaced the order code, which
      // moved to orderCode — keep the order reference on the paper.
      ...(d.orderCode ? [{ label: 'Order', value: d.orderCode }] : []),
      { label: 'Date', value: d.date },
      ...(d.dueDate ? [{ label: 'Due', value: d.dueDate }] : []),
      { label: 'Status', value: d.status.replace(/_/g, ' ') },
    ],
    partyLabel: 'Bill to',
    party: d.customer,
    warehouse: d.warehouse,
    columns: [
      { header: 'Product', align: 'left', width: 235 },
      { header: 'Qty', align: 'right', width: 80 },
      { header: 'Unit price', align: 'right', width: 90 },
      { header: 'Amount', align: 'right', width: 90 },
    ],
    rows: d.lines.map((l) => [
      skuName(l.sku, l.name),
      `${l.quantity} ${l.unit}`,
      money(l.unitPrice),
      money(l.lineTotal),
    ]),
    summary: invoiceSummary(d),
    total: { label: 'Total', value: money(d.total) },
  };
}

export function packingSlipToSpec(d: PackingSlipDocument): DocumentPdfSpec {
  return {
    title: 'Packing Slip',
    metaRight: [
      { label: 'No.', value: d.number },
      ...(d.orderCode ? [{ label: 'Order', value: d.orderCode }] : []),
      { label: 'Date', value: d.date },
      { label: 'Status', value: d.status.replace(/_/g, ' ') },
    ],
    partyLabel: 'Ship to',
    party: d.customer,
    warehouse: d.warehouse,
    columns: [
      { header: 'Product', align: 'left', width: 315 },
      { header: 'Ordered', align: 'right', width: 90 },
      { header: 'Shipped', align: 'right', width: 90 },
    ],
    rows: d.lines.map((l) => [
      skuName(l.sku, l.name),
      `${l.ordered} ${l.unit}`,
      `${l.shipped} ${l.unit}`,
    ]),
    note: 'Please check goods received against the shipped quantities above and report any discrepancy.',
  };
}

export function creditNoteToSpec(d: CreditNoteDocument): DocumentPdfSpec {
  return {
    title: 'Credit Note',
    metaRight: [
      { label: 'No.', value: d.number },
      // The manually entered credit-note code an issued series number replaced.
      ...(d.sourceCode ? [{ label: 'Ref', value: d.sourceCode }] : []),
      { label: 'Date', value: d.date },
      { label: 'Order', value: d.orderCode },
    ],
    partyLabel: 'Credit to',
    party: d.customer,
    warehouse: null,
    columns: [
      { header: 'Product', align: 'left', width: 235 },
      { header: 'Qty', align: 'right', width: 80 },
      { header: 'Unit price', align: 'right', width: 90 },
      { header: 'Credit', align: 'right', width: 90 },
    ],
    rows: d.lines.map((l) => [
      skuName(l.sku, l.name),
      `${l.quantity} ${l.unit}`,
      money(l.unitPrice),
      money(l.lineTotal),
    ]),
    total: { label: 'Total credited', value: money(d.total) },
  };
}

export const renderInvoicePdf = (d: InvoiceDocument) => composeDocumentPdf(invoiceToSpec(d));
export const renderPackingSlipPdf = (d: PackingSlipDocument) => composeDocumentPdf(packingSlipToSpec(d));
export const renderCreditNotePdf = (d: CreditNoteDocument) => composeDocumentPdf(creditNoteToSpec(d));

/** The shape the statement PDF needs — the customer as a party, plus their aged open invoices. */
export interface StatementPdfData {
  party: DocumentParty;
  asOf: string;
  invoices: { documentNumber: string; issuedAt: string; dueDate: string; daysOverdue: number; open: number }[];
  buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  outstanding: number;
}

/** A customer statement of account: open invoices aged, with a bucket summary line and the balance. */
export function statementToSpec(d: StatementPdfData): DocumentPdfSpec {
  const b = d.buckets;
  const agingNote =
    `Aging — not yet due ${money(b.current)} · 1–30 ${money(b.d1_30)} · 31–60 ${money(b.d31_60)} · ` +
    `61–90 ${money(b.d61_90)} · 90+ ${money(b.d90_plus)}`;
  return {
    title: 'Statement',
    metaRight: [{ label: 'As of', value: d.asOf }],
    partyLabel: 'Account',
    party: d.party,
    warehouse: null,
    columns: [
      { header: 'Invoice', align: 'left', width: 130 },
      { header: 'Issued', align: 'left', width: 85 },
      { header: 'Due', align: 'left', width: 85 },
      { header: 'Overdue', align: 'right', width: 75 },
      { header: 'Balance', align: 'right', width: 120 },
    ],
    rows: d.invoices.map((i) => [
      i.documentNumber,
      i.issuedAt.slice(0, 10),
      i.dueDate.slice(0, 10),
      i.daysOverdue > 0 ? `${i.daysOverdue}d` : '—',
      money(i.open),
    ]),
    total: { label: 'Total outstanding', value: money(d.outstanding) },
    note: d.invoices.length > 0 ? agingNote : 'No open invoices — this account has a nil balance.',
  };
}

export const renderStatementPdf = (d: StatementPdfData) => composeDocumentPdf(statementToSpec(d));

export interface LedgerPdfData {
  party: DocumentParty;
  start: string;
  end: string;
  closingBalance: number;
  entries: {
    date: string;
    type: string;
    reference: string | null;
    debit: number | null;
    credit: number | null;
    balance: number;
  }[];
}

const LEDGER_LABEL: Record<string, string> = {
  opening: 'Balance brought forward',
  invoice: 'Invoice',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  payment: 'Payment',
  bill: 'Bill',
};

/**
 * A customer's account as a running-balance register: a brought-forward opening line,
 * each dated transaction with charges / payments, and a carried balance down to what's
 * due. The balance-forward counterpart to statementToSpec's open-items aging.
 */
export function ledgerToSpec(d: LedgerPdfData): DocumentPdfSpec {
  return {
    title: 'Statement of Account',
    metaRight: [
      { label: 'From', value: d.start },
      { label: 'To', value: d.end },
    ],
    partyLabel: 'Account',
    party: d.party,
    warehouse: null,
    columns: [
      { header: 'Date', align: 'left', width: 70 },
      { header: 'Detail', align: 'left', width: 175 },
      { header: 'Charges', align: 'right', width: 80 },
      { header: 'Payments', align: 'right', width: 80 },
      { header: 'Balance', align: 'right', width: 90 },
    ],
    rows: d.entries.map((e) => {
      const label = LEDGER_LABEL[e.type] ?? e.type;
      const detail = e.type === 'opening' ? label : e.reference ? `${label} ${e.reference}` : label;
      return [
        e.type === 'opening' ? '' : e.date.slice(0, 10),
        detail,
        e.debit != null ? money(e.debit) : '',
        e.credit != null ? money(e.credit) : '',
        money(e.balance),
      ];
    }),
    total: { label: 'Balance due', value: money(d.closingBalance) },
    note:
      d.entries.length <= 1
        ? 'No account activity in this period — the balance is unchanged.'
        : 'Charges raise the balance; credit notes and payments reduce it. Balance due is the amount owed at the close of the period.',
  };
}

export const renderLedgerPdf = (d: LedgerPdfData) => composeDocumentPdf(ledgerToSpec(d));

const ISSUED_PDF_PREFIX: Record<string, string> = {
  invoice: 'Invoice',
  packing_slip: 'PackingSlip',
  credit_note: 'CreditNote',
};

/** Render an issued document's frozen snapshot to a PDF, dispatched by kind. */
export async function renderIssuedPdf(
  kind: string,
  snapshot: unknown,
  opts?: { watermark?: string },
): Promise<Uint8Array> {
  let spec: DocumentPdfSpec;
  switch (kind) {
    case 'invoice':
      spec = invoiceToSpec(snapshot as InvoiceDocument);
      break;
    case 'packing_slip':
      spec = packingSlipToSpec(snapshot as PackingSlipDocument);
      break;
    case 'credit_note':
      spec = creditNoteToSpec(snapshot as CreditNoteDocument);
      break;
    default:
      throw new Error(`unknown document kind: ${kind}`);
  }
  if (opts?.watermark) spec = { ...spec, watermark: opts.watermark };
  return composeDocumentPdf(spec);
}

/** The PDF filename prefix for an issued document kind (defaults to "Document"). */
export function issuedPdfPrefix(kind: string): string {
  return ISSUED_PDF_PREFIX[kind] ?? 'Document';
}

/** Filesystem-safe filename stem from a document code (e.g. "Invoice-SO-2026-001"). */
export function pdfFilename(prefix: string, code: string): string {
  const safe = code.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
  return `${prefix}-${safe}.pdf`;
}

/**
 * Wrap PDF bytes in a Response served inline, with a safe filename. The bytes are copied
 * into a fresh `Uint8Array` so the body is a plain `BodyInit` regardless of the source
 * buffer's element type.
 */
export function pdfResponse(bytes: Uint8Array, prefix: string, code: string): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${pdfFilename(prefix, code)}"`,
    },
  });
}

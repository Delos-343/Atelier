import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export interface TaxReport {
  periodStart: string;
  periodEnd: string;
  outputTax: number;
  taxableSales: number;
  invoiceCount: number;
  inputTax: number;
  taxablePurchases: number;
  billCount: number;
  netPayable: number;
}

/** Output-vs-input PPN over a date window; every figure was frozen when it happened. */
export async function getTaxReport(supabase: DbClient, start: string, end: string): Promise<ServerResult<TaxReport>> {
  try {
    const { data, error } = await supabase.rpc('tax_report', { p_start: start, p_end: end });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to build the tax report.' }) };
    const row = (data ?? [])[0];
    const report: TaxReport = row
      ? {
          periodStart: row.period_start,
          periodEnd: row.period_end,
          outputTax: Number(row.output_tax),
          taxableSales: Number(row.taxable_sales),
          invoiceCount: Number(row.invoice_count),
          inputTax: Number(row.input_tax),
          taxablePurchases: Number(row.taxable_purchases),
          billCount: Number(row.bill_count),
          netPayable: Number(row.net_payable),
        }
      : {
          periodStart: start,
          periodEnd: end,
          outputTax: 0,
          taxableSales: 0,
          invoiceCount: 0,
          inputTax: 0,
          taxablePurchases: 0,
          billCount: 0,
          netPayable: 0,
        };
    return { ok: true, data: report };
  } catch (e) {
    logger.error('taxReport.getTaxReport threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to build the tax report.', status: 500 };
  }
}

/** One document on the Faktur Pajak line list — a sales invoice (output) or a bill (input). */
export interface TaxReportLine {
  side: 'output' | 'input';
  documentNumber: string;
  docDate: string;
  partyCode: string;
  partyName: string;
  partyTaxId: string | null;
  taxableBase: number;
  taxAmount: number;
}

/**
 * The per-document detail behind getTaxReport: every taxed invoice and bill in the period.
 * Its filters mirror tax_report exactly, so the lines sum back to the report's totals — a
 * faithful decomposition, ready to export for a PPN filing.
 */
export async function getTaxReportLines(
  supabase: DbClient,
  start: string,
  end: string,
): Promise<ServerResult<TaxReportLine[]>> {
  try {
    const { data, error } = await supabase.rpc('tax_report_lines', { p_start: start, p_end: end });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to build the faktur list.' }) };
    const rows: TaxReportLine[] = (data ?? []).map((r) => ({
      side: r.side as 'output' | 'input',
      documentNumber: r.document_number,
      docDate: r.doc_date,
      partyCode: r.party_code,
      partyName: r.party_name,
      partyTaxId: r.party_tax_id,
      taxableBase: Number(r.taxable_base),
      taxAmount: Number(r.tax_amount),
    }));
    return { ok: true, data: rows };
  } catch (e) {
    logger.error('taxReport.getTaxReportLines threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to build the faktur list.', status: 500 };
  }
}

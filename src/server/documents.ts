import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

/** Shared party block (the customer, as printed on a document). */
export interface DocumentParty {
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface DocumentWarehouse {
  code: string;
  name: string;
}

export interface InvoiceLine {
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoiceDocument {
  kind: 'invoice';
  number: string;
  date: string;
  status: string;
  customer: DocumentParty;
  warehouse: DocumentWarehouse | null;
  lines: InvoiceLine[];
  total: number;
  /**
   * The money breakdown, present on invoices issued from v0.40.0 on. Older snapshots
   * carry only `total`; readers fall back to it when these are absent.
   */
  subtotal?: number;
  discountPct?: number;
  discountAmount?: number;
  taxableAmount?: number;
  taxRate?: number;
  taxAmount?: number;
  /** Net days on the customer's terms, and the resulting due date (issue date + terms on an issued snapshot). */
  paymentTermsDays?: number;
  dueDate?: string;
  /** Present on an ISSUED snapshot: the sales-order code the series number replaced. */
  orderCode?: string;
}

export interface PackingSlipLine {
  sku: string;
  name: string;
  ordered: number;
  shipped: number;
  unit: string;
}

export interface PackingSlipDocument {
  kind: 'packing-slip';
  number: string;
  date: string;
  status: string;
  customer: DocumentParty;
  warehouse: DocumentWarehouse | null;
  lines: PackingSlipLine[];
  /** Present on an ISSUED snapshot: the sales-order code the series number replaced. */
  orderCode?: string;
}

export interface CreditNoteLine {
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export interface CreditNoteDocument {
  kind: 'credit-note';
  number: string;
  date: string;
  orderCode: string;
  customer: DocumentParty;
  lines: CreditNoteLine[];
  total: number;
  /** Present on an ISSUED snapshot: the manually entered credit-note code the series number replaced. */
  sourceCode?: string;
}

/** Invoice for a sales order (ordered quantities × unit price). */
export async function getInvoiceDocument(
  supabase: DbClient,
  orderId: string,
): Promise<ServerResult<InvoiceDocument>> {
  try {
    const { data, error } = await supabase.rpc('invoice_document', { p_order_id: orderId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to build the invoice.' }) };
    if (!data) return { ok: false, error: 'Order not found.', status: 404 };
    return { ok: true, data: data as unknown as InvoiceDocument };
  } catch (e) {
    logger.error('documents.getInvoiceDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to build the invoice.', status: 500 };
  }
}

/** Packing slip for a sales order (ordered vs shipped, no prices). */
export async function getPackingSlipDocument(
  supabase: DbClient,
  orderId: string,
): Promise<ServerResult<PackingSlipDocument>> {
  try {
    const { data, error } = await supabase.rpc('packing_slip_document', { p_order_id: orderId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to build the packing slip.' }) };
    if (!data) return { ok: false, error: 'Order not found.', status: 404 };
    return { ok: true, data: data as unknown as PackingSlipDocument };
  } catch (e) {
    logger.error('documents.getPackingSlipDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to build the packing slip.', status: 500 };
  }
}

/** Credit note for a return (refunded lines × unit price). */
export async function getCreditNoteDocument(
  supabase: DbClient,
  creditNoteId: string,
): Promise<ServerResult<CreditNoteDocument>> {
  try {
    const { data, error } = await supabase.rpc('credit_note_document', {
      p_credit_note_id: creditNoteId,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to build the credit note.' }) };
    if (!data) return { ok: false, error: 'Credit note not found.', status: 404 };
    return { ok: true, data: data as unknown as CreditNoteDocument };
  } catch (e) {
    logger.error('documents.getCreditNoteDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to build the credit note.', status: 500 };
  }
}

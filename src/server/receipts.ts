import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

/** One application of a receipt to an invoice (an invoice_payment tagged with the receipt). */
export interface ReceiptApplication {
  id: string;
  documentNumber: string;
  amount: number;
  paidDate: string;
}

/** A customer receipt with its applied / unapplied split and the invoices it settled. */
export interface CustomerReceipt {
  id: string;
  customerId: string;
  customerName: string;
  receiptDate: string;
  amount: number;
  applied: number;
  unapplied: number;
  applicationCount: number;
  method: string | null;
  reference: string | null;
  applications: ReceiptApplication[];
}

export interface ReceiptsSummary {
  /** Money received but not yet applied — the customer's credit on account. */
  onAccount: number;
  receiptCount: number;
}

/** A live invoice with a balance, ready to receive an allocation. */
export interface OpenInvoice {
  issuedDocumentId: string;
  documentNumber: string;
  issuedAt: string;
  dueDate: string | null;
  total: number;
  paid: number;
  allocated: number;
  open: number;
  status: string;
  overdue: boolean;
}

/**
 * Receipts (for a customer, or all), each with its applied/unapplied split and the
 * applications behind it. The split comes ONLY from list_customer_receipts(); the
 * application rows are embedded from the receipt's invoice_payments for the history.
 */
export async function listReceipts(
  supabase: DbClient,
  customerId?: string,
): Promise<ServerResult<{ receipts: CustomerReceipt[]; summary: ReceiptsSummary }>> {
  try {
    const [receiptsRes, appsRes] = await Promise.all([
      supabase.rpc('list_customer_receipts', customerId ? { p_customer_id: customerId } : {}),
      supabase.from('customer_receipts').select('id, invoice_payments(id, amount, paid_date, issued_documents(document_number))'),
    ]);
    if (receiptsRes.error) {
      return { ok: false, ...mapRpcError(receiptsRes.error, { fallback: 'Failed to load receipts.' }) };
    }
    if (appsRes.error) {
      return { ok: false, ...mapRpcError(appsRes.error, { fallback: 'Failed to load receipt applications.' }) };
    }
    const appsByReceipt = new Map<string, ReceiptApplication[]>(
      (appsRes.data ?? []).map((r) => [
        r.id,
        (r.invoice_payments ?? [])
          .map((p) => ({
            id: p.id,
            documentNumber: p.issued_documents?.document_number ?? '—',
            amount: Number(p.amount),
            paidDate: p.paid_date,
          }))
          .sort((a, b) => (a.documentNumber < b.documentNumber ? -1 : 1)),
      ]),
    );
    const receipts: CustomerReceipt[] = (receiptsRes.data ?? []).map((r) => ({
      id: r.receipt_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      receiptDate: r.receipt_date,
      amount: Number(r.amount),
      applied: Number(r.applied),
      unapplied: Number(r.unapplied),
      applicationCount: Number(r.application_count),
      method: r.method,
      reference: r.reference,
      applications: appsByReceipt.get(r.receipt_id) ?? [],
    }));
    const summary: ReceiptsSummary = {
      onAccount: receipts.reduce((s, r) => s + r.unapplied, 0),
      receiptCount: receipts.length,
    };
    return { ok: true, data: { receipts, summary } };
  } catch (e) {
    logger.error('receipts.listReceipts threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load receipts.', status: 500 };
  }
}

/** A customer's live invoices that still carry a balance, oldest due first. */
export async function listCustomerOpenInvoices(
  supabase: DbClient,
  customerId: string,
): Promise<ServerResult<OpenInvoice[]>> {
  try {
    const { data, error } = await supabase.rpc('customer_open_invoices', { p_customer_id: customerId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load open invoices.' }) };
    const invoices: OpenInvoice[] = (data ?? []).map((r) => ({
      issuedDocumentId: r.issued_document_id,
      documentNumber: r.document_number,
      issuedAt: r.issued_at,
      dueDate: (r.due_date as string | null) ?? null,
      total: Number(r.total),
      paid: Number(r.paid),
      allocated: Number(r.allocated),
      open: Number(r.open),
      status: r.status,
      overdue: r.overdue === true,
    }));
    return { ok: true, data: invoices };
  } catch (e) {
    logger.error('receipts.listCustomerOpenInvoices threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load open invoices.', status: 500 };
  }
}

export interface ReceiptAllocation {
  invoiceId: string;
  amount: number;
}

export interface CreateReceiptInput {
  customerId: string;
  receiptDate: string;
  amount: number;
  method: string | null;
  reference: string | null;
  allocations: ReceiptAllocation[];
}

/** Bank a receipt and apply it. Guards (admin, amount, balances) live in the functions. */
export async function applyCustomerReceipt(
  supabase: DbClient,
  input: CreateReceiptInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('apply_customer_receipt', {
      p_customer_id: input.customerId,
      p_receipt_date: input.receiptDate,
      p_amount: input.amount,
      p_method: input.method ?? '',
      p_reference: input.reference ?? '',
      p_allocations: input.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to record the receipt.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('receipts.applyCustomerReceipt threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to record the receipt.', status: 500 };
  }
}

/** Apply more of an existing receipt's unapplied balance across invoices. */
export async function applyReceipt(
  supabase: DbClient,
  receiptId: string,
  allocations: ReceiptAllocation[],
): Promise<ServerResult<null>> {
  try {
    const { error } = await supabase.rpc('apply_receipt', {
      p_receipt_id: receiptId,
      p_allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })),
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to apply the receipt.' }) };
    return { ok: true, data: null };
  } catch (e) {
    logger.error('receipts.applyReceipt threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to apply the receipt.', status: 500 };
  }
}

/** Delete a receipt, reversing every application it made (invoices reopen). */
export async function deleteReceipt(supabase: DbClient, id: string): Promise<ServerResult<null>> {
  try {
    const { error } = await supabase.rpc('delete_receipt', { p_id: id });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to delete the receipt.' }) };
    return { ok: true, data: null };
  } catch (e) {
    logger.error('receipts.deleteReceipt threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to delete the receipt.', status: 500 };
  }
}

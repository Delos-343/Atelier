import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export type IssuedDocumentKind = 'invoice' | 'packing_slip' | 'credit_note';

/** One recorded send of an issued document (a row means the mail server accepted it). */
export interface IssuedDocumentEmail {
  recipient: string;
  sentAt: string;
}

/** One payment recorded against an issued invoice. */
export interface IssuedDocumentPayment {
  id: string;
  amount: number;
  paidDate: string;
  method: string | null;
  reference: string | null;
}

/** A credit-note allocation touching this document. */
export interface IssuedDocumentAllocation {
  id: string;
  amount: number;
  allocatedDate: string;
  /** The counterpart: the credit note (when viewing an invoice) or the invoice (when viewing a credit note). */
  counterpartId: string;
  counterpartNumber: string;
  counterpartOrderId: string;
}

/** A row in the issued-document archive (without the frozen snapshot). */
export interface IssuedDocumentSummary {
  id: string;
  kind: IssuedDocumentKind;
  documentNumber: string;
  issuedAt: string;
  issuedBy: string | null;
  /** Set when the document has been voided (with the on-record reason). */
  voided: boolean;
  voidReason: string | null;
  /** The monetary claim at 2 dp (invoices and credit notes); null for packing slips. */
  total: number | null;
  /** Sends recorded against this document, newest first. */
  emails: IssuedDocumentEmail[];
  /** Payments recorded against this invoice, newest first (empty for other kinds). */
  payments: IssuedDocumentPayment[];
  /** Derived by invoice_receivables() in SQL — the single derivation. Null for non-invoices. */
  paid: number | null;
  /** Credit applied to this invoice from credit notes (invoices only; null otherwise). */
  allocated: number | null;
  open: number | null;
  paymentStatus: 'open' | 'partially_paid' | 'paid' | 'void' | null;
  /** For credit notes: how much of the note has been applied, and what remains (null otherwise). */
  creditAllocated: number | null;
  creditRemaining: number | null;
  /** Allocations touching this document: for an invoice, credits applied to it; for a credit note, where it's applied. */
  allocations: IssuedDocumentAllocation[];
}

/** An issued document with its frozen snapshot, for re-rendering the PDF. */
export interface IssuedDocumentDetail {
  id: string;
  kind: IssuedDocumentKind;
  documentNumber: string;
  snapshot: unknown;
  /** When set, the document is voided — renders watermarked, and must not be emailed. */
  voidedAt: string | null;
}

export interface IssueDocumentInput {
  kind: IssuedDocumentKind;
  orderId?: string | null;
  creditNoteId?: string | null;
}

/** Issue (freeze) a document — snapshots the current builder output as an immutable record. */
export async function issueDocument(
  supabase: DbClient,
  input: IssueDocumentInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('issue_document', {
      p_kind: input.kind,
      p_order_id: input.orderId ?? undefined,
      p_credit_note_id: input.creditNoteId ?? undefined,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to issue the document.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('issuedDocuments.issueDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to issue the document.', status: 500 };
  }
}

/** List the documents issued against an order, newest first. */
export async function listIssuedDocuments(
  supabase: DbClient,
  orderId: string,
): Promise<ServerResult<IssuedDocumentSummary[]>> {
  try {
    // Reads: the archive rows (with email + payment histories embedded), the
    // SQL-derived receivables state for this order's invoices, the credit-note
    // balances, and the allocations touching this order's documents. Status / paid /
    // open / allocated figures come ONLY from invoice_receivables() — the single
    // derivation — never recomputed here.
    const [docsRes, recvRes, creditRes, allocRes] = await Promise.all([
      supabase
        .from('issued_documents')
        .select(
          'id, kind, document_number, issued_at, issued_by, voided_at, void_reason, total, document_emails(recipient, sent_at), invoice_payments(id, amount, paid_date, method, reference)',
        )
        .eq('sales_order_id', orderId)
        .order('issued_at', { ascending: false }),
      supabase.rpc('invoice_receivables', { p_order_id: orderId }),
      supabase.rpc('credit_note_balances', { p_order_id: orderId }),
      supabase.rpc('credit_allocations_view', { p_order_id: orderId }),
    ]);
    if (docsRes.error) {
      return { ok: false, ...mapRpcError(docsRes.error, { fallback: 'Failed to load issued documents.' }) };
    }
    if (recvRes.error) {
      return { ok: false, ...mapRpcError(recvRes.error, { fallback: 'Failed to load payment status.' }) };
    }
    if (creditRes.error) {
      return { ok: false, ...mapRpcError(creditRes.error, { fallback: 'Failed to load credit balances.' }) };
    }
    if (allocRes.error) {
      return { ok: false, ...mapRpcError(allocRes.error, { fallback: 'Failed to load credit allocations.' }) };
    }
    const recv = new Map(
      (recvRes.data ?? []).map((r) => [
        r.issued_document_id,
        {
          paid: Number(r.paid),
          allocated: Number(r.allocated),
          open: Number(r.open),
          status: r.status as 'open' | 'partially_paid' | 'paid' | 'void',
        },
      ]),
    );
    const credit = new Map(
      (creditRes.data ?? []).map((r) => [
        r.issued_document_id,
        { allocated: Number(r.allocated), remaining: Number(r.remaining) },
      ]),
    );
    // Group allocations by the invoice they reduce and by the credit note they draw
    // on, so each document lists its own side of the link.
    const allocByInvoice = new Map<string, IssuedDocumentAllocation[]>();
    const allocByCreditNote = new Map<string, IssuedDocumentAllocation[]>();
    for (const a of allocRes.data ?? []) {
      const amount = Number(a.amount);
      const push = (map: Map<string, IssuedDocumentAllocation[]>, key: string, alloc: IssuedDocumentAllocation) => {
        const list = map.get(key);
        if (list) list.push(alloc);
        else map.set(key, [alloc]);
      };
      push(allocByInvoice, a.invoice_id, {
        id: a.allocation_id,
        amount,
        allocatedDate: a.allocated_date,
        counterpartId: a.credit_note_id,
        counterpartNumber: a.credit_note_number,
        counterpartOrderId: a.credit_note_order_id,
      });
      push(allocByCreditNote, a.credit_note_id, {
        id: a.allocation_id,
        amount,
        allocatedDate: a.allocated_date,
        counterpartId: a.invoice_id,
        counterpartNumber: a.invoice_number,
        counterpartOrderId: a.invoice_order_id,
      });
    }
    const rows: IssuedDocumentSummary[] = (docsRes.data ?? []).map((r) => {
      const state = recv.get(r.id) ?? null;
      const creditBal = credit.get(r.id) ?? null;
      return {
        id: r.id,
        kind: r.kind as IssuedDocumentKind,
        documentNumber: r.document_number,
        issuedAt: r.issued_at,
        issuedBy: r.issued_by,
        voided: r.voided_at != null,
        voidReason: r.void_reason,
        total: r.total == null ? null : Number(r.total),
        emails: (r.document_emails ?? [])
          .map((e) => ({ recipient: e.recipient, sentAt: e.sent_at }))
          .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1)),
        payments: (r.invoice_payments ?? [])
          .map((p) => ({
            id: p.id,
            amount: Number(p.amount),
            paidDate: p.paid_date,
            method: p.method,
            reference: p.reference,
          }))
          .sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1)),
        paid: state ? state.paid : null,
        allocated: state ? state.allocated : null,
        open: state ? state.open : null,
        paymentStatus: state ? state.status : null,
        creditAllocated: creditBal ? creditBal.allocated : null,
        creditRemaining: creditBal ? creditBal.remaining : null,
        allocations:
          r.kind === 'credit_note'
            ? (allocByCreditNote.get(r.id) ?? [])
            : (allocByInvoice.get(r.id) ?? []),
      };
    });
    return { ok: true, data: rows };
  } catch (e) {
    logger.error('issuedDocuments.listIssuedDocuments threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load issued documents.', status: 500 };
  }
}

/** Fetch one issued document with its frozen snapshot, for rendering. */
export async function getIssuedDocument(
  supabase: DbClient,
  id: string,
): Promise<ServerResult<IssuedDocumentDetail>> {
  try {
    const { data, error } = await supabase
      .from('issued_documents')
      .select('id, kind, document_number, snapshot, voided_at')
      .eq('id', id)
      .maybeSingle();
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load the document.' }) };
    if (!data) return { ok: false, error: 'Issued document not found.', status: 404 };
    return {
      ok: true,
      data: {
        id: data.id,
        kind: data.kind as IssuedDocumentKind,
        documentNumber: data.document_number,
        snapshot: data.snapshot,
        voidedAt: data.voided_at,
      },
    };
  } catch (e) {
    logger.error('issuedDocuments.getIssuedDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the document.', status: 500 };
  }
}

export interface RecordEmailInput {
  issuedDocumentId: string;
  recipient: string;
  subject: string;
  message: string;
}

/**
 * Record that an issued document was emailed. Called AFTER the SMTP send succeeds —
 * a row in document_emails means "the mail server accepted this", never "we tried".
 * The insert happens only inside the admin-gated SECURITY DEFINER function
 * (the table has no write policy), so `sent_by` is the real caller's auth.uid().
 */
export async function recordIssuedDocumentEmail(
  supabase: DbClient,
  input: RecordEmailInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('record_document_email', {
      p_issued_document_id: input.issuedDocumentId,
      p_recipient: input.recipient,
      p_subject: input.subject,
      p_message: input.message,
    });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to record the email.' }) };
    }
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('issuedDocuments.recordIssuedDocumentEmail threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to record the email.', status: 500 };
  }
}

export interface RecordPaymentInput {
  issuedDocumentId: string;
  amount: number;
  paidDate: string;
  method: string | null;
  reference: string | null;
}

/**
 * Record a payment against an issued invoice. All the business guards — admin
 * clearance, invoice kind, not voided, 2 dp, never past the open balance under a
 * row lock — live in record_invoice_payment(); this wrapper only carries the call.
 */
export async function recordInvoicePayment(
  supabase: DbClient,
  input: RecordPaymentInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('record_invoice_payment', {
      p_issued_document_id: input.issuedDocumentId,
      p_amount: input.amount,
      p_paid_date: input.paidDate,
      p_method: input.method ?? undefined,
      p_reference: input.reference ?? undefined,
    });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to record the payment.' }) };
    }
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('issuedDocuments.recordInvoicePayment threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to record the payment.', status: 500 };
  }
}

/** Delete a hand-keyed payment (admin correction; the DEFINER function gates it). */
export async function deleteInvoicePayment(
  supabase: DbClient,
  paymentId: string,
): Promise<ServerResult<{ deleted: true }>> {
  try {
    const { error } = await supabase.rpc('delete_invoice_payment', { p_id: paymentId });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to delete the payment.' }) };
    }
    return { ok: true, data: { deleted: true } };
  } catch (e) {
    logger.error('issuedDocuments.deleteInvoicePayment threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to delete the payment.', status: 500 };
  }
}

/** Void a mis-issued document, with the reason on the permanent record. */
export async function voidIssuedDocument(
  supabase: DbClient,
  id: string,
  reason: string,
): Promise<ServerResult<{ voided: true }>> {
  try {
    const { error } = await supabase.rpc('void_issued_document', { p_id: id, p_reason: reason });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to void the document.' }) };
    }
    return { ok: true, data: { voided: true } };
  } catch (e) {
    logger.error('issuedDocuments.voidIssuedDocument threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to void the document.', status: 500 };
  }
}

export interface AllocateCreditInput {
  invoiceId: string;
  creditNoteId: string;
  amount: number;
  allocatedDate: string;
}

/**
 * Apply a credit note to an open invoice. Every guard — admin clearance, both kinds,
 * same customer, neither voided, never past the credit's remaining or the invoice's
 * open balance under a row lock — lives in allocate_credit_note(); this only carries
 * the call.
 */
export async function allocateCreditNote(
  supabase: DbClient,
  input: AllocateCreditInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('allocate_credit_note', {
      p_credit_note_id: input.creditNoteId,
      p_invoice_id: input.invoiceId,
      p_amount: input.amount,
      p_allocated_date: input.allocatedDate,
    });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to apply the credit note.' }) };
    }
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('issuedDocuments.allocateCreditNote threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to apply the credit note.', status: 500 };
  }
}

/** Remove a credit allocation (admin correction; reopens both balances). */
export async function deleteCreditAllocation(
  supabase: DbClient,
  allocationId: string,
): Promise<ServerResult<{ deleted: true }>> {
  try {
    const { error } = await supabase.rpc('delete_credit_allocation', { p_id: allocationId });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to remove the allocation.' }) };
    }
    return { ok: true, data: { deleted: true } };
  } catch (e) {
    logger.error('issuedDocuments.deleteCreditAllocation threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to remove the allocation.', status: 500 };
  }
}

/** One row of the documents register: an issued document with its order, a send summary, and (for invoices) receivable state. */
export interface IssuedDocumentRegisterRow {
  id: string;
  kind: IssuedDocumentKind;
  documentNumber: string;
  salesOrderId: string;
  orderCode: string;
  customerName: string;
  issuedAt: string;
  /** The monetary claim at 2 dp (invoices / credit notes); null for packing slips. */
  total: number | null;
  voided: boolean;
  voidReason: string | null;
  emailCount: number;
  lastEmailedAt: string | null;
  lastRecipient: string | null;
  /** Reused from invoice_receivables(); null for non-invoices. */
  paymentStatus: 'open' | 'partially_paid' | 'paid' | 'void' | null;
  paid: number | null;
  open: number | null;
}

export interface IssuedDocumentRegisterSummary {
  total: number;
  invoices: number;
  packingSlips: number;
  creditNotes: number;
  voided: number;
  emailed: number;
}

/**
 * The documents register: every issued document across all orders, each with its
 * order and customer, a one-line send summary, and — for invoices — the receivable
 * status reused from invoice_receivables() (the single derivation, so the register
 * and the order pages cannot disagree). Read-only; the API route gates admin.
 */
export async function listIssuedDocumentsRegister(
  supabase: DbClient,
): Promise<
  ServerResult<{ documents: IssuedDocumentRegisterRow[]; summary: IssuedDocumentRegisterSummary }>
> {
  try {
    const { data, error } = await supabase.rpc('issued_documents_register', {});
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load the documents register.' }) };
    }
    const documents: IssuedDocumentRegisterRow[] = (data ?? []).map((r) => ({
      id: r.issued_document_id,
      kind: r.kind as IssuedDocumentKind,
      documentNumber: r.document_number,
      salesOrderId: r.sales_order_id,
      orderCode: r.order_code,
      customerName: r.customer_name,
      issuedAt: r.issued_at,
      total: r.total == null ? null : Number(r.total),
      voided: r.voided,
      voidReason: (r.void_reason as string | null) ?? null,
      emailCount: r.email_count,
      lastEmailedAt: (r.last_emailed_at as string | null) ?? null,
      lastRecipient: (r.last_recipient as string | null) ?? null,
      paymentStatus: (r.payment_status as IssuedDocumentRegisterRow['paymentStatus']) ?? null,
      paid: r.paid == null ? null : Number(r.paid),
      open: r.open == null ? null : Number(r.open),
    }));
    const summary: IssuedDocumentRegisterSummary = {
      total: documents.length,
      invoices: documents.filter((d) => d.kind === 'invoice').length,
      packingSlips: documents.filter((d) => d.kind === 'packing_slip').length,
      creditNotes: documents.filter((d) => d.kind === 'credit_note').length,
      voided: documents.filter((d) => d.voided).length,
      emailed: documents.filter((d) => d.emailCount > 0).length,
    };
    return { ok: true, data: { documents, summary } };
  } catch (e) {
    logger.error('issuedDocuments.listIssuedDocumentsRegister threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the documents register.', status: 500 };
  }
}

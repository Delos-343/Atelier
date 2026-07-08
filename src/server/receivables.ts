import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

/** One issued invoice in the receivables register, as derived by invoice_receivables(). */
export interface ReceivableInvoice {
  id: string;
  documentNumber: string;
  salesOrderId: string;
  orderCode: string;
  customerName: string;
  issuedAt: string;
  dueDate: string | null;
  total: number;
  paid: number;
  open: number;
  status: 'open' | 'partially_paid' | 'paid' | 'void';
  /** Past its due date with an open balance (and not voided). */
  overdue: boolean;
  paymentCount: number;
  lastPaidDate: string | null;
  voidReason: string | null;
}

export interface ReceivablesSummary {
  /** Σ open balance across open and partially-paid invoices. */
  outstanding: number;
  /** How many invoices still carry an open balance. */
  openCount: number;
  /** Σ collected across all non-void invoices. */
  collected: number;
}

/**
 * The receivables register: every issued invoice with its claim, what has been
 * collected, what remains, and the derived status — all computed by
 * invoice_receivables() in SQL (the single derivation; nothing is recomputed
 * here beyond summing the register's own rows for the header).
 */
export async function listReceivables(
  supabase: DbClient,
): Promise<ServerResult<{ invoices: ReceivableInvoice[]; summary: ReceivablesSummary }>> {
  try {
    const { data, error } = await supabase.rpc('invoice_receivables', {});
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load receivables.' }) };

    const invoices: ReceivableInvoice[] = (data ?? []).map((r) => ({
      id: r.issued_document_id,
      documentNumber: r.document_number,
      salesOrderId: r.sales_order_id,
      orderCode: r.order_code,
      customerName: r.customer_name,
      issuedAt: r.issued_at,
      dueDate: (r.due_date as string | null) ?? null,
      total: Number(r.total),
      paid: Number(r.paid),
      open: Number(r.open),
      status: r.status as ReceivableInvoice['status'],
      overdue: r.overdue === true,
      paymentCount: r.payment_count,
      lastPaidDate: (r.last_paid_date as string | null) ?? null,
      voidReason: (r.void_reason as string | null) ?? null,
    }));

    const live = invoices.filter((i) => i.status === 'open' || i.status === 'partially_paid');
    const summary: ReceivablesSummary = {
      outstanding: live.reduce((s, i) => s + i.open, 0),
      openCount: live.length,
      collected: invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.paid, 0),
    };

    return { ok: true, data: { invoices, summary } };
  } catch (e) {
    logger.error('receivables.listReceivables threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load receivables.', status: 500 };
  }
}

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export const AGING_BUCKETS: AgingBucket[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];

/** Column headers for the aging buckets (current = not yet due). */
export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  current: 'Not yet due',
  d1_30: '1–30 overdue',
  d31_60: '31–60 overdue',
  d61_90: '61–90 overdue',
  d90_plus: '90+ overdue',
};

const emptyBuckets = (): Record<AgingBucket, number> => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90_plus: 0,
});

/** One open invoice on a customer's statement, aged from its due date. */
export interface AgedInvoice {
  issuedDocumentId: string;
  documentNumber: string;
  issuedAt: string;
  dueDate: string;
  /** Days past due as of the report date (negative when not yet due). */
  daysOverdue: number;
  bucket: AgingBucket;
  total: number;
  paid: number;
  open: number;
}

/** A customer's aged receivables: the open balance in each bucket, the running total, and the invoices behind them. */
export interface CustomerAging {
  customerId: string;
  customerName: string;
  buckets: Record<AgingBucket, number>;
  open: number;
  invoices: AgedInvoice[];
}

export interface ReceivablesAgingSummary {
  /** The date the ages were measured against. */
  asOf: string;
  /** Grand total open in each bucket. */
  buckets: Record<AgingBucket, number>;
  /** Grand total open across every bucket. */
  open: number;
  customerCount: number;
  invoiceCount: number;
}

/**
 * Receivables aging: every invoice that still carries an open balance, aged from its
 * issue date and grouped by customer. The age, bucket, and open balance come from
 * receivables_aging() in SQL (which itself reuses invoice_receivables(), the single
 * derivation); this only folds the per-invoice rows into per-customer totals and a
 * grand total for the header — no balance is recomputed here.
 */
export async function listReceivablesAging(
  supabase: DbClient,
  asOf?: string,
): Promise<ServerResult<{ customers: CustomerAging[]; summary: ReceivablesAgingSummary }>> {
  try {
    const { data, error } = await supabase.rpc('receivables_aging', asOf ? { p_as_of: asOf } : {});
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load the aging report.' }) };
    }

    // Group the aged invoice rows by customer, preserving the SQL order
    // (customer_name, then issue date).
    const byCustomer = new Map<string, CustomerAging>();
    const grand = emptyBuckets();

    for (const r of data ?? []) {
      const bucket = r.bucket as AgingBucket;
      const open = Number(r.open);
      let c = byCustomer.get(r.customer_id);
      if (!c) {
        c = {
          customerId: r.customer_id,
          customerName: r.customer_name,
          buckets: emptyBuckets(),
          open: 0,
          invoices: [],
        };
        byCustomer.set(r.customer_id, c);
      }
      c.invoices.push({
        issuedDocumentId: r.issued_document_id,
        documentNumber: r.document_number,
        issuedAt: r.issued_at,
        dueDate: r.due_date,
        daysOverdue: r.days_overdue,
        bucket,
        total: Number(r.total),
        paid: Number(r.paid),
        open,
      });
      c.buckets[bucket] += open;
      c.open += open;
      grand[bucket] += open;
    }

    const customers = [...byCustomer.values()];
    const summary: ReceivablesAgingSummary = {
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
      buckets: grand,
      open: AGING_BUCKETS.reduce((s, b) => s + grand[b], 0),
      customerCount: customers.length,
      invoiceCount: (data ?? []).length,
    };

    return { ok: true, data: { customers, summary } };
  } catch (e) {
    logger.error('receivables.listReceivablesAging threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the aging report.', status: 500 };
  }
}

/** A customer's statement of account: their open invoices, aged, with bucket totals and the balance. */
export interface CustomerStatement {
  customer: {
    id: string;
    code: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  asOf: string;
  invoices: AgedInvoice[];
  buckets: Record<AgingBucket, number>;
  outstanding: number;
}

/** Fold a customer's aged invoices into per-bucket totals and an outstanding sum (pure). */
export function summariseStatement(invoices: AgedInvoice[]): {
  buckets: Record<AgingBucket, number>;
  outstanding: number;
} {
  const buckets = emptyBuckets();
  let outstanding = 0;
  for (const inv of invoices) {
    buckets[inv.bucket] += inv.open;
    outstanding += inv.open;
  }
  return { buckets, outstanding };
}

/**
 * A single customer's statement of account, as of a date. Reuses receivables_aging()
 * (the same derivation behind the aging report) filtered to this customer, plus the
 * customer's contact details for the letterhead — nothing about the balances is
 * recomputed here beyond folding the rows into bucket totals.
 */
export async function getCustomerStatement(
  supabase: DbClient,
  customerId: string,
  asOf?: string,
): Promise<ServerResult<CustomerStatement>> {
  try {
    const [custRes, agingRes] = await Promise.all([
      supabase.from('customers').select('id, code, name, email, phone, address').eq('id', customerId),
      supabase.rpc('receivables_aging', asOf ? { p_as_of: asOf } : {}),
    ]);
    if (custRes.error) {
      return { ok: false, ...mapRpcError(custRes.error, { fallback: 'Failed to load the customer.' }) };
    }
    if (agingRes.error) {
      return { ok: false, ...mapRpcError(agingRes.error, { fallback: 'Failed to load the statement.' }) };
    }

    const invoices: AgedInvoice[] = (agingRes.data ?? [])
      .filter((r) => r.customer_id === customerId)
      .map((r) => ({
        issuedDocumentId: r.issued_document_id,
        documentNumber: r.document_number,
        issuedAt: r.issued_at,
        dueDate: r.due_date,
        daysOverdue: r.days_overdue,
        bucket: r.bucket as AgingBucket,
        total: Number(r.total),
        paid: Number(r.paid),
        open: Number(r.open),
      }));

    const { buckets, outstanding } = summariseStatement(invoices);
    const c = (custRes.data ?? [])[0] ?? null;
    return {
      ok: true,
      data: {
        customer: c
          ? { id: c.id, code: c.code, name: c.name, email: c.email, phone: c.phone, address: c.address }
          : null,
        asOf: asOf ?? new Date().toISOString().slice(0, 10),
        invoices,
        buckets,
        outstanding,
      },
    };
  } catch (e) {
    logger.error('receivables.getCustomerStatement threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the statement.', status: 500 };
  }
}
export type LedgerEntryType = 'opening' | 'invoice' | 'credit_note' | 'receipt' | 'payment';

export interface LedgerEntry {
  date: string;
  type: LedgerEntryType;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number;
}

/**
 * A customer's account as a running-balance register over a period: an opening balance
 * (all activity before the window, netted), then each dated transaction with a carried
 * balance, ending at what's due. Distinct from getCustomerStatement, which lists only
 * open invoices aged into buckets. Everything comes from customer_ledger().
 */
export interface CustomerLedger {
  customer: {
    id: string;
    code: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  start: string;
  end: string;
  openingBalance: number;
  closingBalance: number;
  entries: LedgerEntry[];
  /** The most recent time this exact statement (customer + period) was emailed, if ever. */
  lastEmail: { recipient: string; sentAt: string } | null;
}

export async function getCustomerLedger(
  supabase: DbClient,
  customerId: string,
  start: string,
  end: string,
): Promise<ServerResult<CustomerLedger>> {
  try {
    const [custRes, ledgerRes, emailRes] = await Promise.all([
      supabase.from('customers').select('id, code, name, email, phone, address').eq('id', customerId),
      supabase.rpc('customer_ledger', { p_customer_id: customerId, p_start: start, p_end: end }),
      supabase
        .from('statement_emails')
        .select('recipient, sent_at')
        .eq('customer_id', customerId)
        .eq('period_start', start)
        .eq('period_end', end)
        .order('sent_at', { ascending: false })
        .limit(1),
    ]);
    if (custRes.error) {
      return { ok: false, ...mapRpcError(custRes.error, { fallback: 'Failed to load the customer.' }) };
    }
    if (ledgerRes.error) {
      return { ok: false, ...mapRpcError(ledgerRes.error, { fallback: 'Failed to load the ledger.' }) };
    }

    const entries: LedgerEntry[] = (ledgerRes.data ?? []).map((r) => ({
      date: r.entry_date,
      type: r.entry_type as LedgerEntryType,
      reference: r.reference,
      debit: r.debit === null ? null : Number(r.debit),
      credit: r.credit === null ? null : Number(r.credit),
      balance: Number(r.balance),
    }));
    const opening = entries.find((e) => e.type === 'opening')?.balance ?? 0;
    const closing = entries.length > 0 ? entries[entries.length - 1].balance : opening;
    const c = (custRes.data ?? [])[0] ?? null;
    // A read failure on the (non-essential) send history shouldn't sink the statement.
    const lastRow = emailRes.error ? null : (emailRes.data ?? [])[0] ?? null;
    return {
      ok: true,
      data: {
        customer: c
          ? { id: c.id, code: c.code, name: c.name, email: c.email, phone: c.phone, address: c.address }
          : null,
        start,
        end,
        openingBalance: opening,
        closingBalance: closing,
        entries,
        lastEmail: lastRow ? { recipient: lastRow.recipient, sentAt: lastRow.sent_at } : null,
      },
    };
  } catch (e) {
    logger.error('receivables.getCustomerLedger threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the ledger.', status: 500 };
  }
}

export interface RecordStatementEmailInput {
  customerId: string;
  periodStart: string;
  periodEnd: string;
  recipient: string;
  subject: string;
}

/**
 * Record that a customer's statement of account was emailed. Called AFTER the SMTP send
 * succeeds — a row in statement_emails means "the mail server accepted this". The insert
 * happens only inside the admin-gated SECURITY DEFINER function (the table has no write
 * policy), so sent_by is the real caller's auth.uid().
 */
export async function recordStatementEmail(
  supabase: DbClient,
  input: RecordStatementEmailInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('record_statement_email', {
      p_customer_id: input.customerId,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_recipient: input.recipient,
      p_subject: input.subject,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to record the email.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('receivables.recordStatementEmail threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to record the email.', status: 500 };
  }
}


export interface AvailableCredit {
  id: string;
  documentNumber: string;
  issuedAt: string;
  total: number;
  allocated: number;
  remaining: number;
}

/** A customer's credit notes that still carry usable credit (remaining > 0, not voided). */
export async function listCustomerCredits(
  supabase: DbClient,
  customerId: string,
): Promise<ServerResult<AvailableCredit[]>> {
  try {
    const { data, error } = await supabase.rpc('credit_note_balances', { p_customer_id: customerId });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load available credits.' }) };
    }
    const credits: AvailableCredit[] = (data ?? [])
      .filter((r) => !r.voided && Number(r.remaining) > 0)
      .map((r) => ({
        id: r.issued_document_id,
        documentNumber: r.document_number,
        issuedAt: r.issued_at,
        total: Number(r.total),
        allocated: Number(r.allocated),
        remaining: Number(r.remaining),
      }));
    return { ok: true, data: credits };
  } catch (e) {
    logger.error('receivables.listCustomerCredits threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load available credits.', status: 500 };
  }
}

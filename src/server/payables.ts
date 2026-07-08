import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';
import {
  type AgingBucket,
  AGING_BUCKETS,
  AGING_BUCKET_LABEL,
} from './receivables';

// The payables side reuses the receivables aging buckets exactly.
export { AGING_BUCKETS, AGING_BUCKET_LABEL, type AgingBucket };

export interface BillPayment {
  id: string;
  amount: number;
  paidDate: string;
  method: string | null;
  reference: string | null;
}

/** A bill with its derived payable state and payment history. */
export interface BillSummary {
  id: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  dueDate: string | null;
  amount: number;
  paid: number;
  open: number;
  status: 'open' | 'partially_paid' | 'paid' | 'void';
  overdue: boolean;
  voided: boolean;
  voidReason: string | null;
  payments: BillPayment[];
}

/**
 * The bills for a supplier (or all), each with its derived state and payment history.
 * open / paid / status / overdue come ONLY from bill_payables() — the single AP
 * derivation, the mirror of invoice_receivables() — never recomputed here; the payment
 * rows are embedded from the bill for the pay-card history.
 */
export async function listBills(
  supabase: DbClient,
  supplierId?: string,
): Promise<ServerResult<BillSummary[]>> {
  try {
    const [payHistoryRes, payablesRes] = await Promise.all([
      supabase.from('bills').select('id, bill_payments(id, amount, paid_date, method, reference)'),
      supabase.rpc('bill_payables', supplierId ? { p_supplier_id: supplierId } : {}),
    ]);
    if (payHistoryRes.error) {
      return { ok: false, ...mapRpcError(payHistoryRes.error, { fallback: 'Failed to load bills.' }) };
    }
    if (payablesRes.error) {
      return { ok: false, ...mapRpcError(payablesRes.error, { fallback: 'Failed to load payable status.' }) };
    }
    const paymentsByBill = new Map<string, BillPayment[]>(
      (payHistoryRes.data ?? []).map((b) => [
        b.id,
        (b.bill_payments ?? [])
          .map((p) => ({
            id: p.id,
            amount: Number(p.amount),
            paidDate: p.paid_date,
            method: p.method,
            reference: p.reference,
          }))
          .sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1)),
      ]),
    );
    const bills: BillSummary[] = (payablesRes.data ?? []).map((r) => ({
      id: r.bill_id,
      billNumber: r.bill_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      billDate: r.bill_date,
      dueDate: (r.due_date as string | null) ?? null,
      amount: Number(r.amount),
      paid: Number(r.paid),
      open: Number(r.open),
      status: r.status as BillSummary['status'],
      overdue: r.overdue === true,
      voided: r.status === 'void',
      voidReason: (r.void_reason as string | null) ?? null,
      payments: paymentsByBill.get(r.bill_id) ?? [],
    }));
    return { ok: true, data: bills };
  } catch (e) {
    logger.error('payables.listBills threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load bills.', status: 500 };
  }
}

export interface CreateBillInput {
  supplierId: string;
  billNumber: string;
  billDate: string;
  amount: number;
  dueDate: string | null;
  description: string | null;
  taxAmount: number;
}

/** Enter a supplier bill. Guards (admin, amount, supplier exists, due date from terms) live in create_bill(). */
export async function createBill(
  supabase: DbClient,
  input: CreateBillInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('create_bill', {
      p_supplier_id: input.supplierId,
      p_bill_number: input.billNumber,
      p_bill_date: input.billDate,
      p_amount: input.amount,
      p_due_date: input.dueDate ?? undefined,
      p_description: input.description ?? undefined,
      p_tax_amount: input.taxAmount,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to create the bill.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('payables.createBill threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to create the bill.', status: 500 };
  }
}

export interface RecordBillPaymentInput {
  billId: string;
  amount: number;
  paidDate: string;
  method: string | null;
  reference: string | null;
}

/** Record a payment against a bill. Every guard lives in record_bill_payment(); this only carries the call. */
export async function recordBillPayment(
  supabase: DbClient,
  input: RecordBillPaymentInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('record_bill_payment', {
      p_bill_id: input.billId,
      p_amount: input.amount,
      p_paid_date: input.paidDate,
      p_method: input.method ?? undefined,
      p_reference: input.reference ?? undefined,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to record the payment.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('payables.recordBillPayment threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to record the payment.', status: 500 };
  }
}

/** Delete a bill payment (admin correction; reopens the balance). */
export async function deleteBillPayment(
  supabase: DbClient,
  paymentId: string,
): Promise<ServerResult<{ deleted: true }>> {
  try {
    const { error } = await supabase.rpc('delete_bill_payment', { p_id: paymentId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to delete the payment.' }) };
    return { ok: true, data: { deleted: true } };
  } catch (e) {
    logger.error('payables.deleteBillPayment threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to delete the payment.', status: 500 };
  }
}

/** Void a bill (with the reason on record; blocked once it has payments). */
export async function voidBill(
  supabase: DbClient,
  id: string,
  reason: string,
): Promise<ServerResult<{ voided: true }>> {
  try {
    const { error } = await supabase.rpc('void_bill', { p_id: id, p_reason: reason });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to void the bill.' }) };
    return { ok: true, data: { voided: true } };
  } catch (e) {
    logger.error('payables.voidBill threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to void the bill.', status: 500 };
  }
}

// ── payables register (mirror of the receivables register) ───────────────────────
export interface PayableBill {
  id: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  dueDate: string | null;
  amount: number;
  paid: number;
  open: number;
  status: 'open' | 'partially_paid' | 'paid' | 'void';
  overdue: boolean;
  voidReason: string | null;
}

export interface PayablesSummary {
  /** Σ open across open and partially-paid bills. */
  outstanding: number;
  openCount: number;
  /** Σ paid across all non-void bills. */
  paidOut: number;
}

/** The payables register: every bill with its amount, paid, open, and status, from bill_payables(). */
export async function listPayables(
  supabase: DbClient,
): Promise<ServerResult<{ bills: PayableBill[]; summary: PayablesSummary }>> {
  try {
    const { data, error } = await supabase.rpc('bill_payables', {});
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load payables.' }) };

    const bills: PayableBill[] = (data ?? []).map((r) => ({
      id: r.bill_id,
      billNumber: r.bill_number,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      billDate: r.bill_date,
      dueDate: (r.due_date as string | null) ?? null,
      amount: Number(r.amount),
      paid: Number(r.paid),
      open: Number(r.open),
      status: r.status as PayableBill['status'],
      overdue: r.overdue === true,
      voidReason: (r.void_reason as string | null) ?? null,
    }));

    const live = bills.filter((b) => b.status === 'open' || b.status === 'partially_paid');
    const summary: PayablesSummary = {
      outstanding: live.reduce((s, b) => s + b.open, 0),
      openCount: live.length,
      paidOut: bills.filter((b) => b.status !== 'void').reduce((s, b) => s + b.paid, 0),
    };
    return { ok: true, data: { bills, summary } };
  } catch (e) {
    logger.error('payables.listPayables threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load payables.', status: 500 };
  }
}

// ── payables aging (mirror of the receivables aging report) ──────────────────────
export interface AgedBill {
  billId: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  daysOverdue: number;
  bucket: AgingBucket;
  amount: number;
  paid: number;
  open: number;
}

export interface SupplierAging {
  supplierId: string;
  supplierName: string;
  buckets: Record<AgingBucket, number>;
  open: number;
  bills: AgedBill[];
}

export interface PayablesAgingSummary {
  asOf: string;
  buckets: Record<AgingBucket, number>;
  open: number;
  supplierCount: number;
  billCount: number;
}

const emptyBuckets = (): Record<AgingBucket, number> => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d90_plus: 0,
});

/** Payables aging: every open bill aged from its due date, grouped by supplier — the AP mirror of the aging report. */
export async function listPayablesAging(
  supabase: DbClient,
  asOf?: string,
): Promise<ServerResult<{ suppliers: SupplierAging[]; summary: PayablesAgingSummary }>> {
  try {
    const { data, error } = await supabase.rpc('payables_aging', asOf ? { p_as_of: asOf } : {});
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load the aging report.' }) };

    const bySupplier = new Map<string, SupplierAging>();
    const grand = emptyBuckets();

    for (const r of data ?? []) {
      const bucket = r.bucket as AgingBucket;
      const open = Number(r.open);
      let s = bySupplier.get(r.supplier_id);
      if (!s) {
        s = {
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          buckets: emptyBuckets(),
          open: 0,
          bills: [],
        };
        bySupplier.set(r.supplier_id, s);
      }
      s.bills.push({
        billId: r.bill_id,
        billNumber: r.bill_number,
        billDate: r.bill_date,
        dueDate: r.due_date,
        daysOverdue: r.days_overdue,
        bucket,
        amount: Number(r.amount),
        paid: Number(r.paid),
        open,
      });
      s.buckets[bucket] += open;
      s.open += open;
      grand[bucket] += open;
    }

    const suppliers = [...bySupplier.values()];
    const summary: PayablesAgingSummary = {
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
      buckets: grand,
      open: AGING_BUCKETS.reduce((sum, b) => sum + grand[b], 0),
      supplierCount: suppliers.length,
      billCount: (data ?? []).length,
    };
    return { ok: true, data: { suppliers, summary } };
  } catch (e) {
    logger.error('payables.listPayablesAging threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load the aging report.', status: 500 };
  }
}

export type SupplierLedgerEntryType = 'opening' | 'bill' | 'payment';

export interface SupplierLedgerEntry {
  date: string;
  type: SupplierLedgerEntryType;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number;
}

/**
 * A supplier's account as a running-balance register over a period: an opening balance
 * (all activity before the window, netted), then each dated bill and payment with a
 * carried balance, ending at what's owed. The AP counterpart to getCustomerLedger; the
 * balance is what we owe the vendor. Everything comes from supplier_ledger().
 */
export interface SupplierLedger {
  supplier: {
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
  entries: SupplierLedgerEntry[];
}

export async function getSupplierLedger(
  supabase: DbClient,
  supplierId: string,
  start: string,
  end: string,
): Promise<ServerResult<SupplierLedger>> {
  try {
    const [supRes, ledgerRes] = await Promise.all([
      supabase.from('suppliers').select('id, code, name, email, phone, address').eq('id', supplierId),
      supabase.rpc('supplier_ledger', { p_supplier_id: supplierId, p_start: start, p_end: end }),
    ]);
    if (supRes.error) {
      return { ok: false, ...mapRpcError(supRes.error, { fallback: 'Failed to load the supplier.' }) };
    }
    if (ledgerRes.error) {
      return { ok: false, ...mapRpcError(ledgerRes.error, { fallback: 'Failed to load the ledger.' }) };
    }

    const entries: SupplierLedgerEntry[] = (ledgerRes.data ?? []).map((r) => ({
      date: r.entry_date,
      type: r.entry_type as SupplierLedgerEntryType,
      reference: r.reference,
      debit: r.debit === null ? null : Number(r.debit),
      credit: r.credit === null ? null : Number(r.credit),
      balance: Number(r.balance),
    }));
    const opening = entries.find((e) => e.type === 'opening')?.balance ?? 0;
    const closing = entries.length > 0 ? entries[entries.length - 1].balance : opening;
    const s = (supRes.data ?? [])[0] ?? null;
    return {
      ok: true,
      data: {
        supplier: s
          ? { id: s.id, code: s.code, name: s.name, email: s.email, phone: s.phone, address: s.address }
          : null,
        start,
        end,
        openingBalance: opening,
        closingBalance: closing,
        entries,
      },
    };
  } catch (e) {
    logger.error('payables.getSupplierLedger threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load the ledger.', status: 500 };
  }
}

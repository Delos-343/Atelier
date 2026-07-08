import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export interface PurchaseOrderLine {
  id: string;
  lineNo: number;
  rawMaterialId: string;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  unitCost: number;
  receivedQuantity: number;
}

export interface PurchaseOrderSummary {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string;
  warehouseName: string;
  orderDate: string;
  status: string;
  lineCount: number;
  orderedValue: number;
  receivedValue: number;
  billed: number;
  billedTax: number;
  billedNet: number;
  variance: number;
  matchStatus: string;
  lines: PurchaseOrderLine[];
}

/**
 * Purchase orders with their ordered/received/billed value (from the register) and their
 * lines with receive-progress (embedded from purchase_order_lines). Mirrors listBills:
 * the totals come only from the register; the lines are attached for the detail view.
 */
export async function listPurchaseOrders(supabase: DbClient): Promise<ServerResult<PurchaseOrderSummary[]>> {
  try {
    const [regRes, linesRes] = await Promise.all([
      supabase.rpc('purchase_order_register'),
      supabase.from('purchase_orders').select('id, purchase_order_lines(id, line_no, raw_material_id, quantity, unit, unit_cost, received_quantity, raw_materials(sku, name))'),
    ]);
    if (regRes.error) return { ok: false, ...mapRpcError(regRes.error, { fallback: 'Failed to load purchase orders.' }) };
    if (linesRes.error) return { ok: false, ...mapRpcError(linesRes.error, { fallback: 'Failed to load purchase order lines.' }) };

    const linesByPo = new Map<string, PurchaseOrderLine[]>(
      (linesRes.data ?? []).map((po) => [
        po.id,
        (po.purchase_order_lines ?? [])
          .map((l) => ({
            id: l.id,
            lineNo: Number(l.line_no),
            rawMaterialId: l.raw_material_id,
            sku: l.raw_materials?.sku ?? '—',
            name: l.raw_materials?.name ?? '—',
            quantity: Number(l.quantity),
            unit: l.unit,
            unitCost: Number(l.unit_cost),
            receivedQuantity: Number(l.received_quantity),
          }))
          .sort((a, b) => a.lineNo - b.lineNo),
      ]),
    );

    const orders: PurchaseOrderSummary[] = (regRes.data ?? []).map((r) => ({
      id: r.purchase_order_id,
      code: r.code,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      warehouseName: r.warehouse_name,
      orderDate: r.order_date,
      status: r.status,
      lineCount: Number(r.line_count),
      orderedValue: Number(r.ordered_value),
      receivedValue: Number(r.received_value),
      billed: Number(r.billed),
      billedTax: Number(r.billed_tax),
      billedNet: Number(r.billed_net),
      variance: Number(r.variance),
      matchStatus: r.match_status,
      lines: linesByPo.get(r.purchase_order_id) ?? [],
    }));
    return { ok: true, data: orders };
  } catch (e) {
    logger.error('procurement.listPurchaseOrders threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load purchase orders.', status: 500 };
  }
}

export interface PurchaseOrderException {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string;
  orderedValue: number;
  receivedValue: number;
  billedNet: number;
  variance: number;
  matchStatus: 'over_billed' | 'under_billed';
}

/**
 * The billing exceptions the three-way match flags — purchase orders billed ahead of or
 * short of the goods received — worth resolving before a payment goes out. A filter over
 * the register (purchase_order_exceptions), so it can never disagree with the match badge.
 */
export async function listPurchaseOrderExceptions(
  supabase: DbClient,
  supplierId?: string,
): Promise<ServerResult<PurchaseOrderException[]>> {
  try {
    const { data, error } = await supabase.rpc(
      'purchase_order_exceptions',
      supplierId ? { p_supplier_id: supplierId } : {},
    );
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load billing exceptions.' }) };
    const rows: PurchaseOrderException[] = (data ?? []).map((r) => ({
      id: r.purchase_order_id,
      code: r.code,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      orderedValue: Number(r.ordered_value),
      receivedValue: Number(r.received_value),
      billedNet: Number(r.billed_net),
      variance: Number(r.variance),
      matchStatus: r.match_status as 'over_billed' | 'under_billed',
    }));
    return { ok: true, data: rows };
  } catch (e) {
    logger.error('procurement.listPurchaseOrderExceptions threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load billing exceptions.', status: 500 };
  }
}

export interface CreatePurchaseOrderInput {
  code: string;
  supplierId: string;
  warehouseId: string;
  orderDate: string;
  lines: { rawMaterialId: string; quantity: number; unit: string; unitCost: number }[];
}

export async function createPurchaseOrder(
  supabase: DbClient,
  input: CreatePurchaseOrderInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('create_purchase_order', {
      p_code: input.code,
      p_supplier_id: input.supplierId,
      p_warehouse_id: input.warehouseId,
      p_order_date: input.orderDate,
      p_lines: input.lines.map((l) => ({
        raw_material_id: l.rawMaterialId,
        quantity: l.quantity,
        unit: l.unit,
        unit_cost: l.unitCost,
      })),
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to raise the purchase order.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('procurement.createPurchaseOrder threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to raise the purchase order.', status: 500 };
  }
}

export interface ReceiptLine {
  lineId: string;
  quantity: number;
  lotCode: string;
  expiryDate: string | null;
}

export async function receivePurchaseOrder(
  supabase: DbClient,
  poId: string,
  receipts: ReceiptLine[],
): Promise<ServerResult<null>> {
  try {
    const { error } = await supabase.rpc('receive_purchase_order', {
      p_po_id: poId,
      p_receipts: receipts.map((r) => ({
        lineId: r.lineId,
        quantity: r.quantity,
        lotCode: r.lotCode,
        expiryDate: r.expiryDate ?? '',
      })),
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to receive the purchase order.' }) };
    return { ok: true, data: null };
  } catch (e) {
    logger.error('procurement.receivePurchaseOrder threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to receive the purchase order.', status: 500 };
  }
}

export async function cancelPurchaseOrder(supabase: DbClient, poId: string): Promise<ServerResult<null>> {
  try {
    const { error } = await supabase.rpc('cancel_purchase_order', { p_po_id: poId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to cancel the purchase order.' }) };
    return { ok: true, data: null };
  } catch (e) {
    logger.error('procurement.cancelPurchaseOrder threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to cancel the purchase order.', status: 500 };
  }
}

export interface BillPurchaseOrderInput {
  billNumber: string;
  billDate: string;
  amount: number | null;
  taxAmount: number;
  dueDate: string | null;
  description: string | null;
}

export async function billPurchaseOrder(
  supabase: DbClient,
  poId: string,
  input: BillPurchaseOrderInput,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('bill_purchase_order', {
      p_po_id: poId,
      p_bill_number: input.billNumber,
      p_bill_date: input.billDate,
      p_amount: input.amount ?? undefined,
      p_due_date: input.dueDate ?? undefined,
      p_description: input.description ?? undefined,
      p_tax_amount: input.taxAmount,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to bill the purchase order.' }) };
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('procurement.billPurchaseOrder threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to bill the purchase order.', status: 500 };
  }
}

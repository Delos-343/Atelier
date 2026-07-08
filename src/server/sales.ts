import type { Json } from '@/types/database';
import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';
import { createSalesOrderSchema, setSalesOrderStatusSchema } from '@/schemas/sales';

export interface SalesOrderListItem {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  customerName: string;
}

export interface CostedLine {
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  estUnitCost: number | null;
  lineRevenue: number;
  expectedMargin: number | null;
  shippedQuantity: number; // 0 until shipped
  cogs: number | null; // realized COGS, null until shipped
  realizedMargin: number | null;
  availableQuantity: number; // finished stock on hand for this line's product/warehouse/unit
  returnedQuantity: number; // cumulative returned
}

export interface SalesOrderDetail {
  id: string;
  code: string;
  status: string;
  orderDate: string;
  customer: { id: string; code: string; name: string; email: string | null } | null;
  warehouseId: string;
  lines: CostedLine[];
  totalRevenue: number;
  expectedCogs: number;
  expectedMargin: number | null; // null when any line's product has no costed stock
  realizedRevenue: number | null; // value of what has actually shipped, once shipping starts
  realizedCogs: number | null; // COGS of what has shipped
  realizedMargin: number | null; // realized revenue − realized COGS
  returnedValue: number | null; // credited value of returned goods, once shipping starts
  creditNotes: CreditNoteSummary[]; // returns recorded against this order
}

export interface CreditNoteSummary {
  id: string;
  code: string;
  creditDate: string;
  total: number; // credited value (Σ quantity × unit_price)
  cogsReversed: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export async function createSalesOrder(
  supabase: DbClient,
  input: unknown,
): Promise<ServerResult<{ id: string }>> {
  const parsed = createSalesOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.', status: 400 };
  }
  const dto = parsed.data;
  try {
    const lines: Json = dto.lines.map((l) => ({
      product_id: l.productId,
      quantity: l.quantity,
      unit: l.unit,
      unit_price: l.unitPrice,
    }));
    const { data, error } = await supabase.rpc('create_sales_order', {
      p_code: dto.code,
      p_customer_id: dto.customerId,
      p_warehouse_id: dto.warehouseId,
      p_order_date: dto.orderDate && dto.orderDate.length ? dto.orderDate : today(),
      p_lines: lines,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to create order.' }) };
    logger.info('sales_order.created', { id: data, lines: dto.lines.length });
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('sales.createSalesOrder threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to create order.', status: 500 };
  }
}

export async function listSalesOrders(
  supabase: DbClient,
): Promise<ServerResult<SalesOrderListItem[]>> {
  try {
    const { data, error } = await supabase
      .from('sales_orders')
      .select('id, code, status, order_date, customers(name)')
      .order('created_at', { ascending: false });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load orders.' }) };
    const items = (data ?? []).map((o) => ({
      id: o.id,
      code: o.code,
      status: o.status,
      orderDate: o.order_date,
      customerName: o.customers?.name ?? '—',
    }));
    return { ok: true, data: items };
  } catch (e) {
    logger.error('sales.listSalesOrders threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load orders.', status: 500 };
  }
}

export async function getSalesOrderDetail(
  supabase: DbClient,
  orderId: string,
): Promise<ServerResult<SalesOrderDetail>> {
  try {
    const { data: o, error: oErr } = await supabase
      .from('sales_orders')
      .select('id, code, status, order_date, warehouse_id, customers(id, code, name, email)')
      .eq('id', orderId)
      .maybeSingle();
    if (oErr) return { ok: false, ...mapRpcError(oErr, { fallback: 'Failed to load order.' }) };
    if (!o) return { ok: false, error: 'Sales order not found.', status: 404 };

    const { data: rows, error: lErr } = await supabase.rpc('sales_order_lines_costed', {
      p_order_id: orderId,
    });
    if (lErr) return { ok: false, ...mapRpcError(lErr, { fallback: 'Failed to load lines.' }) };

    const lines: CostedLine[] = (rows ?? []).map((r) => ({
      lineId: r.line_id,
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      quantity: Number(r.quantity),
      unit: r.unit,
      unitPrice: Number(r.unit_price),
      estUnitCost: r.est_unit_cost == null ? null : Number(r.est_unit_cost),
      lineRevenue: Number(r.line_revenue),
      expectedMargin: r.expected_margin == null ? null : Number(r.expected_margin),
      shippedQuantity: Number(r.shipped_quantity),
      cogs: r.cogs == null ? null : Number(r.cogs),
      realizedMargin: r.realized_margin == null ? null : Number(r.realized_margin),
      availableQuantity: Number(r.available_quantity),
      returnedQuantity: Number(r.returned_quantity),
    }));

    const totalRevenue = lines.reduce((s, l) => s + l.lineRevenue, 0);
    const anyUnknown = lines.some((l) => l.estUnitCost == null);
    const expectedCogs = lines.reduce(
      (s, l) => s + (l.estUnitCost == null ? 0 : l.estUnitCost * l.quantity),
      0,
    );
    const expectedMargin = anyUnknown ? null : totalRevenue - expectedCogs;

    // Realized figures accrue as the order ships and net out any returns, so realized
    // margin ties out against the value still with the customer.
    const realized = o.status === 'shipped' || o.status === 'partially_shipped';
    const realizedRevenue = realized
      ? lines.reduce((s, l) => s + l.unitPrice * (l.shippedQuantity - l.returnedQuantity), 0)
      : null;
    const realizedCogs = realized ? lines.reduce((s, l) => s + (l.cogs ?? 0), 0) : null;
    const realizedMargin = realized
      ? lines.reduce((s, l) => s + (l.realizedMargin ?? 0), 0)
      : null;
    const returnedValue = realized
      ? lines.reduce((s, l) => s + l.unitPrice * l.returnedQuantity, 0)
      : null;

    const { data: cnRows, error: cnErr } = await supabase
      .from('credit_notes')
      .select('id, code, credit_date, credit_note_lines(quantity, unit_price, cogs_reversed)')
      .eq('sales_order_id', orderId)
      .order('credit_date', { ascending: true });
    if (cnErr) return { ok: false, ...mapRpcError(cnErr, { fallback: 'Failed to load credit notes.' }) };
    const creditNotes: CreditNoteSummary[] = (cnRows ?? []).map((cn) => {
      const cnLines = cn.credit_note_lines ?? [];
      return {
        id: cn.id,
        code: cn.code,
        creditDate: cn.credit_date,
        total: cnLines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price), 0),
        cogsReversed: cnLines.reduce((s, l) => s + Number(l.cogs_reversed), 0),
      };
    });

    const customer = o.customers
      ? { id: o.customers.id, code: o.customers.code, name: o.customers.name, email: o.customers.email }
      : null;

    return {
      ok: true,
      data: {
        id: o.id,
        code: o.code,
        status: o.status,
        orderDate: o.order_date,
        customer,
        warehouseId: o.warehouse_id,
        lines,
        totalRevenue,
        expectedCogs,
        expectedMargin,
        realizedRevenue,
        realizedCogs,
        realizedMargin,
        returnedValue,
        creditNotes,
      },
    };
  } catch (e) {
    logger.error('sales.getSalesOrderDetail threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load order.', status: 500 };
  }
}

export async function setSalesOrderStatus(
  supabase: DbClient,
  orderId: string,
  input: unknown,
): Promise<ServerResult<{ id: string; status: string }>> {
  const parsed = setSalesOrderStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.', status: 400 };
  }
  try {
    // Guard transitions: confirm only from draft; cancel only before stock has left.
    // Once an order is (partially) shipped, unwinding it is a returns flow, not a cancel.
    const { data: current, error: fErr } = await supabase
      .from('sales_orders')
      .select('status')
      .eq('id', orderId)
      .maybeSingle();
    if (fErr) return { ok: false, ...mapRpcError(fErr, { fallback: 'Failed to load order.' }) };
    if (!current) return { ok: false, error: 'Sales order not found.', status: 404 };

    const legalFrom: Record<'confirmed' | 'cancelled', string[]> = {
      confirmed: ['draft'],
      cancelled: ['draft', 'confirmed'],
    };
    if (!legalFrom[parsed.data.status].includes(current.status)) {
      return {
        ok: false,
        error: `Cannot mark a ${current.status} order as ${parsed.data.status}.`,
        status: 409,
      };
    }

    const { data, error } = await supabase
      .from('sales_orders')
      .update({ status: parsed.data.status })
      .eq('id', orderId)
      .select('id, status')
      .maybeSingle();
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to update status.' }) };
    if (!data) return { ok: false, error: 'Sales order not found.', status: 404 };
    return { ok: true, data: { id: data.id, status: data.status } };
  } catch (e) {
    logger.error('sales.setSalesOrderStatus threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to update status.', status: 500 };
  }
}

export async function shipSalesOrder(
  supabase: DbClient,
  orderId: string,
): Promise<ServerResult<{ id: string }>> {
  try {
    const { error } = await supabase.rpc('ship_sales_order', { p_order_id: orderId });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to ship order.' }) };
    logger.info('sales_order.shipped', { id: orderId });
    return { ok: true, data: { id: orderId } };
  } catch (e) {
    logger.error('sales.shipSalesOrder threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to ship order.', status: 500 };
  }
}

export async function shipSalesOrderLines(
  supabase: DbClient,
  orderId: string,
  lines: { lineId: string; quantity: number }[],
): Promise<ServerResult<{ id: string }>> {
  try {
    const payload = lines.map((l) => ({ line_id: l.lineId, quantity: l.quantity }));
    const { error } = await supabase.rpc('ship_sales_order_lines', {
      p_order_id: orderId,
      p_lines: payload,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to ship order.' }) };
    logger.info('sales_order.shipped_lines', { id: orderId, lines: payload.length });
    return { ok: true, data: { id: orderId } };
  } catch (e) {
    logger.error('sales.shipSalesOrderLines threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to ship order.', status: 500 };
  }
}

export async function createReturn(
  supabase: DbClient,
  orderId: string,
  code: string,
  lines: { lineId: string; quantity: number }[],
): Promise<ServerResult<{ id: string }>> {
  try {
    const payload = lines.map((l) => ({ line_id: l.lineId, quantity: l.quantity }));
    const { data, error } = await supabase.rpc('create_return', {
      p_order_id: orderId,
      p_code: code,
      p_lines: payload,
    });
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to process return.' }) };
    logger.info('sales_order.returned', { id: orderId, creditNote: data });
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('sales.createReturn threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to process return.', status: 500 };
  }
}

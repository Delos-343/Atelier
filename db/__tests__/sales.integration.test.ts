import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function customer(code = 'C1'): Promise<string> {
  const [r] = await q(`insert into customers(code,name) values($1,$1) returning id`, [code]);
  return r.id;
}

/** Insert an AVAILABLE finished lot of a product at a given unit_cost. */
async function finishedLot(productId: string, whId: string, lot: string, qty: number, unit: string, cost: number) {
  await q(
    `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,unit_cost)
     values($1,'product',$2,$3,$4,$5,'available',$6)`,
    [lot, productId, whId, qty, unit, cost],
  );
}

async function createOrder(code: string, customerId: string, whId: string, lines: unknown[]): Promise<string> {
  const [r] = await q(`select create_sales_order($1,$2,$3,$4,$5::jsonb) as id`, [
    code,
    customerId,
    whId,
    '2026-01-01',
    JSON.stringify(lines),
  ]);
  return r.id;
}

describe('sales order capture + expected margin', () => {
  it('creates header and lines atomically', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    const orderId = await createOrder('SO-1', cust, wh, [
      { product_id: prod, quantity: 3, unit: 'l', unit_price: 2.0 },
      { product_id: prod, quantity: 1, unit: 'l', unit_price: 2.5 },
    ]);

    const [{ count: orders }] = await q(`select count(*)::int from sales_orders where id=$1`, [orderId]);
    const [{ count: lineCount }] = await q(
      `select count(*)::int from sales_order_lines where sales_order_id=$1`,
      [orderId],
    );
    expect(orders).toBe(1);
    expect(lineCount).toBe(2);
  });

  it('computes weighted-average product cost and per-line expected margin', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await finishedLot(prod, wh, 'FG-A', 10, 'l', 0.4); // wavg = (10*0.40 + 5*0.50)/15
    await finishedLot(prod, wh, 'FG-B', 5, 'l', 0.5); //      = 0.433333…
    const orderId = await createOrder('SO-1', cust, wh, [
      { product_id: prod, quantity: 3, unit: 'l', unit_price: 2.0 },
    ]);

    const [cost] = await q(`select product_available_cost($1) as c`, [prod]);
    expect(Number(cost.c)).toBeCloseTo(0.433333, 5);

    const [line] = await q(`select * from sales_order_lines_costed($1)`, [orderId]);
    expect(Number(line.est_unit_cost)).toBeCloseTo(0.433333, 5);
    expect(Number(line.line_revenue)).toBeCloseTo(6.0, 6); // 2.00 * 3
    expect(Number(line.expected_margin)).toBeCloseTo(4.7, 4); // (2.00 - 0.43333) * 3
  });

  it('returns null expected margin when the product has no costed available stock', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P-NOSTOCK', 'l');
    const cust = await customer();
    const orderId = await createOrder('SO-2', cust, wh, [
      { product_id: prod, quantity: 4, unit: 'l', unit_price: 9.0 },
    ]);

    const [line] = await q(`select * from sales_order_lines_costed($1)`, [orderId]);
    expect(line.est_unit_cost).toBeNull();
    expect(line.expected_margin).toBeNull();
    expect(Number(line.line_revenue)).toBeCloseTo(36.0, 6); // revenue still known
  });

  it('rolls back the whole order when a line is invalid (atomic create)', async () => {
    const wh = await createWarehouse();
    const cust = await customer();
    // a product_id that does not exist -> FK violation inside the function
    await expect(
      createOrder('SO-BAD', cust, wh, [
        { product_id: '00000000-0000-0000-0000-000000000000', quantity: 1, unit: 'l', unit_price: 1 },
      ]),
    ).rejects.toThrow();

    const [{ count }] = await q(`select count(*)::int from sales_orders where code='SO-BAD'`);
    expect(count).toBe(0); // header rolled back with the failed line
  });
});

describe('sales order shipment + realized COGS', () => {
  const confirm = (orderId: string) =>
    q(`update sales_orders set status='confirmed' where id=$1`, [orderId]);
  const ship = (orderId: string) => q(`select ship_sales_order($1, null)`, [orderId]);
  const availLot = (productId: string, whId: string, code: string, qty: number, cost: number, expiry: string) =>
    q(
      `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,unit_cost,expiry_date)
       values($1,'product',$2,$3,$4,'l','available',$5,$6)`,
      [code, productId, whId, qty, cost, expiry],
    );

  it('ships FEFO across lots, freezes COGS, decrements stock, flips to shipped', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 6, 0.4, '2026-12-01'); // earlier expiry → drawn first
    await availLot(prod, wh, 'FG-B', 10, 0.5, '2027-06-01');
    const orderId = await createOrder('SO-1', cust, wh, [
      { product_id: prod, quantity: 8, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    await ship(orderId);

    const [order] = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(order.status).toBe('shipped');

    const lots = await q(
      `select lot_code, quantity_on_hand, status from inventory_lots where item_type='product' order by lot_code`,
    );
    expect(Number(lots[0].quantity_on_hand)).toBe(0); // FG-A drained first (FEFO)
    expect(lots[0].status).toBe('consumed');
    expect(Number(lots[1].quantity_on_hand)).toBeCloseTo(8, 6); // FG-B has 8 left

    const [line] = await q(
      `select shipped_quantity, cogs from sales_order_lines where sales_order_id=$1`,
      [orderId],
    );
    expect(Number(line.shipped_quantity)).toBeCloseTo(8, 6);
    expect(Number(line.cogs)).toBeCloseTo(3.4, 6); // 6*0.40 + 2*0.50

    const [costed] = await q(`select * from sales_order_lines_costed($1)`, [orderId]);
    expect(Number(costed.realized_margin)).toBeCloseTo(12.6, 6); // 16.00 − 3.40

    const [moves] = await q(
      `select count(*)::int as n, sum(quantity) as net from stock_movements where movement_type='shipment'`,
    );
    expect(moves.n).toBe(2);
    expect(Number(moves.net)).toBeCloseTo(-8, 6);
  });

  it('refuses to ship an order that is not confirmed', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 10, 0.4, '2026-12-01');
    const orderId = await createOrder('SO-DRAFT', cust, wh, [
      { product_id: prod, quantity: 3, unit: 'l', unit_price: 2.0 },
    ]);
    await expect(ship(orderId)).rejects.toThrow();
    const [o] = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(o.status).toBe('draft');
  });

  it('ships available stock now and backorders the rest (partial shipment)', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 5, 0.4, '2026-12-01'); // only 5 available, order needs 8
    const orderId = await createOrder('SO-PARTIAL', cust, wh, [
      { product_id: prod, quantity: 8, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    await ship(orderId);

    const [o] = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(o.status).toBe('partially_shipped'); // 3 still on backorder
    const [line] = await q(
      `select shipped_quantity, cogs from sales_order_lines where sales_order_id=$1`,
      [orderId],
    );
    expect(Number(line.shipped_quantity)).toBeCloseTo(5, 6); // shipped exactly what was available
    expect(Number(line.cogs)).toBeCloseTo(2.0, 6); // 5 * 0.40
    const [lot] = await q(`select quantity_on_hand, status from inventory_lots where lot_code='FG-A'`);
    expect(Number(lot.quantity_on_hand)).toBe(0);
    expect(lot.status).toBe('consumed');
    const [m] = await q(
      `select count(*)::int as n, sum(quantity) as net from stock_movements where movement_type='shipment'`,
    );
    expect(m.n).toBe(1);
    expect(Number(m.net)).toBeCloseTo(-5, 6);
    // realized margin reflects only the shipped portion: 5*2.00 − 2.00 = 8.00
    const [costed] = await q(`select realized_margin from sales_order_lines_costed($1)`, [orderId]);
    expect(Number(costed.realized_margin)).toBeCloseTo(8.0, 6);
  });

  it('completes a backordered order across dispatches, accumulating COGS', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 6, 0.4, '2026-12-01'); // first 6 @ 0.40
    const orderId = await createOrder('SO-MULTI', cust, wh, [
      { product_id: prod, quantity: 10, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    await ship(orderId); // dispatch 1: ships 6, backorders 4

    let rows = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(rows[0].status).toBe('partially_shipped');

    await availLot(prod, wh, 'FG-B', 10, 0.5, '2027-06-01'); // restock @ 0.50
    await ship(orderId); // dispatch 2: ships remaining 4

    rows = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(rows[0].status).toBe('shipped');
    const [line] = await q(
      `select shipped_quantity, cogs from sales_order_lines where sales_order_id=$1`,
      [orderId],
    );
    expect(Number(line.shipped_quantity)).toBeCloseTo(10, 6);
    expect(Number(line.cogs)).toBeCloseTo(4.4, 6); // 6*0.40 + 4*0.50 accumulated
    const [costed] = await q(`select realized_margin from sales_order_lines_costed($1)`, [orderId]);
    expect(Number(costed.realized_margin)).toBeCloseTo(15.6, 6); // 20.00 − 4.40
    const [m] = await q(`select count(*)::int as n from stock_movements where movement_type='shipment'`);
    expect(m.n).toBe(2); // one issue per dispatch
  });

  it('raises when no stock at all is available to ship', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    // no available lots for this product at all
    const orderId = await createOrder('SO-NONE', cust, wh, [
      { product_id: prod, quantity: 4, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    await expect(ship(orderId)).rejects.toThrow();
    const [o] = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(o.status).toBe('confirmed'); // unchanged — caller gets feedback, not a silent no-op
  });

  it('draws only available stock, never quarantined lots', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('P1', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-OK', 10, 0.4, '2026-12-01');
    await q(
      `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,unit_cost,expiry_date)
       values('FG-Q','product',$1,$2,100,'l','quarantine',0.5,'2026-12-01')`,
      [prod, wh],
    );
    const orderId = await createOrder('SO-Q', cust, wh, [
      { product_id: prod, quantity: 8, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    await ship(orderId);

    const [ok] = await q(`select quantity_on_hand from inventory_lots where lot_code='FG-OK'`);
    expect(Number(ok.quantity_on_hand)).toBeCloseTo(2, 6); // 10 − 8
    const [qd] = await q(`select quantity_on_hand, status from inventory_lots where lot_code='FG-Q'`);
    expect(Number(qd.quantity_on_hand)).toBe(100); // quarantine untouched
    expect(qd.status).toBe('quarantine');
    const [line] = await q(`select cogs from sales_order_lines where sales_order_id=$1`, [orderId]);
    expect(Number(line.cogs)).toBeCloseTo(3.2, 6); // 8 * 0.40 from the available lot only
  });
});

describe('sales order deliberate per-line shipment', () => {
  const confirm = (orderId: string) =>
    q(`update sales_orders set status='confirmed' where id=$1`, [orderId]);
  const shipLines = (orderId: string, lines: { line_id: string; quantity: number }[]) =>
    q(`select ship_sales_order_lines($1, $2::jsonb, null)`, [orderId, JSON.stringify(lines)]);
  const availLot = (productId: string, whId: string, code: string, qty: number, cost: number, expiry: string) =>
    q(
      `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,unit_cost,expiry_date)
       values($1,'product',$2,$3,$4,'l','available',$5,$6)`,
      [code, productId, whId, qty, cost, expiry],
    );
  const lineId = async (orderId: string, sku: string): Promise<string> => {
    const [row] = await q(`select line_id from sales_order_lines_costed($1) where sku=$2`, [orderId, sku]);
    return row.line_id as string;
  };

  it('ships exactly the requested quantity per line, then completes across dispatches', async () => {
    const wh = await createWarehouse();
    const pA = await createProduct('PA', 'l');
    const pB = await createProduct('PB', 'l');
    const cust = await customer();
    await availLot(pA, wh, 'FG-A', 8, 0.4, '2026-12-01');
    await availLot(pB, wh, 'FG-B', 5, 0.6, '2026-12-01');
    const orderId = await createOrder('SO-D1', cust, wh, [
      { product_id: pA, quantity: 10, unit: 'l', unit_price: 2.0 },
      { product_id: pB, quantity: 5, unit: 'l', unit_price: 3.0 },
    ]);
    await confirm(orderId);
    const la = await lineId(orderId, 'PA');
    const lb = await lineId(orderId, 'PB');

    // dispatch 1: A:4, B:2
    await shipLines(orderId, [{ line_id: la, quantity: 4 }, { line_id: lb, quantity: 2 }]);
    let rows = await q(
      `select sku, shipped_quantity, cogs, available_quantity from sales_order_lines_costed($1) order by sku`,
      [orderId],
    );
    expect(Number(rows[0].shipped_quantity)).toBeCloseTo(4, 6); // PA
    expect(Number(rows[0].cogs)).toBeCloseTo(1.6, 6); // 4 * 0.40
    expect(Number(rows[0].available_quantity)).toBeCloseTo(4, 6); // 8 − 4 still on hand
    expect(Number(rows[1].shipped_quantity)).toBeCloseTo(2, 6); // PB
    expect(Number(rows[1].cogs)).toBeCloseTo(1.2, 6); // 2 * 0.60
    let rs = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(rs[0].status).toBe('partially_shipped');

    // dispatch 2: A:4 (uses remaining stock), B:3 (completes B)
    await shipLines(orderId, [{ line_id: la, quantity: 4 }, { line_id: lb, quantity: 3 }]);
    rows = await q(`select sku, shipped_quantity from sales_order_lines_costed($1) order by sku`, [orderId]);
    expect(Number(rows[0].shipped_quantity)).toBeCloseTo(8, 6); // PA 8/10
    expect(Number(rows[1].shipped_quantity)).toBeCloseTo(5, 6); // PB done
    rs = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(rs[0].status).toBe('partially_shipped'); // PA still 2 outstanding

    // restock PA at a different cost and finish the last 2
    await availLot(pA, wh, 'FG-A2', 5, 0.5, '2027-06-01');
    await shipLines(orderId, [{ line_id: la, quantity: 2 }]);
    rs = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(rs[0].status).toBe('shipped');
    const [lineA] = await q(`select shipped_quantity, cogs from sales_order_lines where id=$1`, [la]);
    expect(Number(lineA.shipped_quantity)).toBeCloseTo(10, 6);
    expect(Number(lineA.cogs)).toBeCloseTo(4.2, 6); // 8*0.40 + 2*0.50 accumulated
  });

  it('rejects shipping more than a line outstanding', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('PA', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 20, 0.4, '2026-12-01'); // plenty of stock
    const orderId = await createOrder('SO-D2', cust, wh, [
      { product_id: prod, quantity: 10, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    const la = await lineId(orderId, 'PA');
    await expect(shipLines(orderId, [{ line_id: la, quantity: 11 }])).rejects.toThrow();
    const [line] = await q(`select shipped_quantity from sales_order_lines where id=$1`, [la]);
    expect(Number(line.shipped_quantity)).toBe(0); // nothing shipped
  });

  it('rejects shipping more than available stock and rolls back', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('PA', 'l');
    const cust = await customer();
    await availLot(prod, wh, 'FG-A', 5, 0.4, '2026-12-01'); // only 5 in stock
    const orderId = await createOrder('SO-D3', cust, wh, [
      { product_id: prod, quantity: 10, unit: 'l', unit_price: 2.0 },
    ]);
    await confirm(orderId);
    const la = await lineId(orderId, 'PA');
    await expect(shipLines(orderId, [{ line_id: la, quantity: 8 }])).rejects.toThrow();
    const [line] = await q(`select shipped_quantity from sales_order_lines where id=$1`, [la]);
    expect(Number(line.shipped_quantity)).toBe(0); // atomic — nothing shipped
    const [lot] = await q(`select quantity_on_hand from inventory_lots where lot_code='FG-A'`);
    expect(Number(lot.quantity_on_hand)).toBeCloseTo(5, 6); // untouched
    const [o] = await q(`select status from sales_orders where id=$1`, [orderId]);
    expect(o.status).toBe('confirmed'); // unchanged
  });

  it('skips zero-quantity lines and requires at least one positive', async () => {
    const wh = await createWarehouse();
    const pA = await createProduct('PA', 'l');
    const pB = await createProduct('PB', 'l');
    const cust = await customer();
    await availLot(pA, wh, 'FG-A', 10, 0.4, '2026-12-01');
    await availLot(pB, wh, 'FG-B', 10, 0.6, '2026-12-01');
    const orderId = await createOrder('SO-D4', cust, wh, [
      { product_id: pA, quantity: 5, unit: 'l', unit_price: 2.0 },
      { product_id: pB, quantity: 5, unit: 'l', unit_price: 3.0 },
    ]);
    await confirm(orderId);
    const la = await lineId(orderId, 'PA');
    const lb = await lineId(orderId, 'PB');

    // all-zero request → raises (nothing to ship)
    await expect(
      shipLines(orderId, [{ line_id: la, quantity: 0 }, { line_id: lb, quantity: 0 }]),
    ).rejects.toThrow();

    // A:0, B:3 → ships only B, leaves A untouched
    await shipLines(orderId, [{ line_id: la, quantity: 0 }, { line_id: lb, quantity: 3 }]);
    const rows = await q(
      `select sku, shipped_quantity from sales_order_lines_costed($1) order by sku`,
      [orderId],
    );
    expect(Number(rows[0].shipped_quantity)).toBe(0); // PA untouched
    expect(Number(rows[1].shipped_quantity)).toBeCloseTo(3, 6); // PB shipped 3
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createRawMaterial } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const VIEWER = '22222222-2222-2222-2222-222222222222';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function asUser<T>(sub: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('set role authenticated');
    await client.query(`set app.jwt_sub = '${sub}'`);
    return await fn(client);
  } finally {
    await client.query('reset role').catch(() => {});
    client.release();
  }
}

async function seedRoles(): Promise<void> {
  await q(
    `insert into app_users(user_id, role) values($1,'admin'),($2,'viewer') on conflict do nothing`,
    [ADMIN, VIEWER],
  );
}

async function createSupplier(tag: string): Promise<string> {
  await seedRoles();
  const [s] = await q<{ id: string }>(
    `insert into suppliers(code,name,payment_terms_days) values($1,$1,30) returning id`,
    [`S-${tag}`],
  );
  return s.id;
}

interface POLine {
  raw_material_id: string;
  quantity: number;
  unit: string;
  unit_cost: number;
}

async function createPO(supplier: string, warehouse: string, tag: string, lines: POLine[], as = ADMIN): Promise<string> {
  return asUser(as, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select create_purchase_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
      [`PO-${tag}`, supplier, warehouse, JSON.stringify(lines)],
    );
    return rows[0].id;
  });
}

async function receivePO(
  poId: string,
  receipts: { lineId: string; quantity: number; lotCode: string; expiryDate?: string }[],
  as = ADMIN,
) {
  return asUser(as, (c) => c.query(`select receive_purchase_order($1,$2::jsonb)`, [poId, JSON.stringify(receipts)]));
}

async function register(poId: string) {
  const [row] = await q<any>(`select * from purchase_order_register($1)`, [poId]);
  return row;
}

async function poLines(poId: string) {
  return q<any>(`select * from purchase_order_lines where purchase_order_id=$1 order by line_no`, [poId]);
}

async function lotsFor(rawId: string) {
  return q<any>(`select * from inventory_lots where raw_material_id=$1 order by lot_code`, [rawId]);
}

const iso = (d: unknown) => new Date(d as string).toISOString().slice(0, 10);

describe('procurement', () => {
  it('raises a purchase order with lines, open and unbilled', async () => {
    const sup = await createSupplier('a');
    const wh = await createWarehouse('WH-a');
    const rm = await createRawMaterial({ sku: 'RM-a', unit: 'g' });

    const po = await createPO(sup, wh, 'a', [{ raw_material_id: rm, quantity: 100, unit: 'g', unit_cost: 2 }]);
    const reg = await register(po);
    expect(reg.status).toBe('open');
    expect(Number(reg.line_count)).toBe(1);
    expect(Number(reg.ordered_value)).toBe(200); // 100 × 2
    expect(Number(reg.received_value)).toBe(0);
    expect(Number(reg.billed)).toBe(0);
  });

  it('receives a line into a raw lot that lands in inventory, and closes the order', async () => {
    const sup = await createSupplier('b');
    const wh = await createWarehouse('WH-b');
    const rm = await createRawMaterial({ sku: 'RM-b', unit: 'g' });
    const po = await createPO(sup, wh, 'b', [{ raw_material_id: rm, quantity: 100, unit: 'g', unit_cost: 2 }]);
    const [line] = await poLines(po);

    await receivePO(po, [{ lineId: line.id, quantity: 100, lotCode: 'LOT-b1', expiryDate: '2027-01-01' }]);

    const lots = await lotsFor(rm);
    expect(lots).toHaveLength(1);
    expect(lots[0].item_type).toBe('raw');
    expect(lots[0].status).toBe('available');
    expect(Number(lots[0].quantity_on_hand)).toBe(100); // the 'receipt' movement landed
    expect(iso(lots[0].expiry_date)).toBe('2027-01-01');
    expect(Number(lots[0].unit_cost)).toBe(2);

    const reg = await register(po);
    expect(reg.status).toBe('received');
    expect(Number(reg.received_value)).toBe(200);
  });

  it('tracks a partial receipt, then completes it with a second delivery', async () => {
    const sup = await createSupplier('c');
    const wh = await createWarehouse('WH-c');
    const rm = await createRawMaterial({ sku: 'RM-c', unit: 'g' });
    const po = await createPO(sup, wh, 'c', [{ raw_material_id: rm, quantity: 100, unit: 'g', unit_cost: 3 }]);
    const [line] = await poLines(po);

    await receivePO(po, [{ lineId: line.id, quantity: 60, lotCode: 'LOT-c1' }]);
    let reg = await register(po);
    expect(reg.status).toBe('partially_received');
    expect(Number(reg.received_value)).toBe(180); // 60 × 3
    expect(Number((await poLines(po))[0].received_quantity)).toBe(60);

    await receivePO(po, [{ lineId: line.id, quantity: 40, lotCode: 'LOT-c2' }]);
    reg = await register(po);
    expect(reg.status).toBe('received');
    expect(Number(reg.received_value)).toBe(300);
    expect(await lotsFor(rm)).toHaveLength(2); // two deliveries, two lots
  });

  it('refuses to over-receive a line', async () => {
    const sup = await createSupplier('d');
    const wh = await createWarehouse('WH-d');
    const rm = await createRawMaterial({ sku: 'RM-d', unit: 'g' });
    const po = await createPO(sup, wh, 'd', [{ raw_material_id: rm, quantity: 100, unit: 'g', unit_cost: 1 }]);
    const [line] = await poLines(po);

    await expect(
      receivePO(po, [{ lineId: line.id, quantity: 150, lotCode: 'LOT-d1' }]),
    ).rejects.toThrow(/exceeds the .* outstanding/i);
    // nothing received — no lot, still open
    expect(await lotsFor(rm)).toHaveLength(0);
    expect((await register(po)).status).toBe('open');
  });

  it('bills a purchase order, feeding payables and linking the bill back to the order', async () => {
    const sup = await createSupplier('e');
    const wh = await createWarehouse('WH-e');
    const rm = await createRawMaterial({ sku: 'RM-e', unit: 'g' });
    const po = await createPO(sup, wh, 'e', [{ raw_material_id: rm, quantity: 100, unit: 'g', unit_cost: 2 }]);
    const [line] = await poLines(po);
    await receivePO(po, [{ lineId: line.id, quantity: 100, lotCode: 'LOT-e1' }]);

    // amount omitted → defaults to the received value (200)
    const billId = await asUser(ADMIN, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select bill_purchase_order($1,$2,$3,null,null,null) as id`,
        [po, 'SUP-INV-e', '2026-07-05'],
      );
      return rows[0].id;
    });

    const [bill] = await q<any>(`select * from bills where id=$1`, [billId]);
    expect(bill.purchase_order_id).toBe(po);
    expect(Number(bill.amount)).toBe(200);

    // it shows up in the payables derivation, and the register counts it
    const payables = await q<any>(`select * from bill_payables($1)`, [sup]);
    expect(payables).toHaveLength(1);
    expect(Number((await register(po)).billed)).toBe(200);
  });

  it('cancels an open order but not one that has received stock', async () => {
    const sup = await createSupplier('f');
    const wh = await createWarehouse('WH-f');
    const rm = await createRawMaterial({ sku: 'RM-f', unit: 'g' });

    const open = await createPO(sup, wh, 'f1', [{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 1 }]);
    await asUser(ADMIN, (c) => c.query(`select cancel_purchase_order($1)`, [open]));
    expect((await register(open)).status).toBe('cancelled');

    const touched = await createPO(sup, wh, 'f2', [{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 1 }]);
    const [line] = await poLines(touched);
    await receivePO(touched, [{ lineId: line.id, quantity: 4, lotCode: 'LOT-f2' }]);
    await expect(
      asUser(ADMIN, (c) => c.query(`select cancel_purchase_order($1)`, [touched])),
    ).rejects.toThrow(/only an open/i);
  });

  it('is admin-only and select-only', async () => {
    const sup = await createSupplier('g');
    const wh = await createWarehouse('WH-g');
    const rm = await createRawMaterial({ sku: 'RM-g', unit: 'g' });

    await expect(
      createPO(sup, wh, 'g', [{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 1 }], VIEWER),
    ).rejects.toThrow(/administrator/i);

    // an admin PO that a viewer then tries to receive / write directly
    const po = await createPO(sup, wh, 'g', [{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 1 }]);
    const [line] = await poLines(po);
    await expect(
      receivePO(po, [{ lineId: line.id, quantity: 1, lotCode: 'LOT-g' }], VIEWER),
    ).rejects.toThrow(/administrator/i);
    await expect(
      asUser(VIEWER, (c) => c.query(`insert into purchase_orders(code,supplier_id,warehouse_id) values('X',$1,$2)`, [sup, wh])),
    ).rejects.toThrow();
  });
});

describe('procurement three-way match', () => {
  // A PO of 10 units at cost 5 → ordered/received value 50 once fully received.
  async function setup(tag: string) {
    const sup = await createSupplier(`m${tag}`);
    const wh = await createWarehouse(`WH-m${tag}`);
    const rm = await createRawMaterial({ sku: `RM-m${tag}`, unit: 'g' });
    const po = await createPO(sup, wh, `m${tag}`, [{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 5 }]);
    const [line] = await poLines(po);
    await receivePO(po, [{ lineId: line.id, quantity: 10, lotCode: `LOT-m${tag}` }]);
    return { po };
  }
  async function bill(poId: string, tag: string, amount: number | null, tax = 0) {
    return asUser(ADMIN, (c) =>
      c.query(`select bill_purchase_order($1,$2,'2026-07-05',$3,null,null,$4) as id`, [poId, `SUP-INV-m${tag}`, amount, tax]),
    );
  }

  it('matches when the bill equals the received value', async () => {
    const { po } = await setup('1');
    await bill(po, '1', null); // amount omitted → defaults to received value (50)
    const r = await register(po);
    expect(Number(r.billed_net)).toBe(50);
    expect(Number(r.variance)).toBe(0);
    expect(r.match_status).toBe('matched');
  });

  it('flags an over-bill when the bill exceeds the received value', async () => {
    const { po } = await setup('2');
    await bill(po, '2', 60);
    const r = await register(po);
    expect(Number(r.variance)).toBe(10);
    expect(r.match_status).toBe('over_billed');
  });

  it('flags an under-bill when the bill is short of the received value', async () => {
    const { po } = await setup('3');
    await bill(po, '3', 40);
    const r = await register(po);
    expect(Number(r.variance)).toBe(-10);
    expect(r.match_status).toBe('under_billed');
  });

  it('marks a received-but-unbilled order as unbilled', async () => {
    const { po } = await setup('4');
    const r = await register(po);
    expect(Number(r.billed_net)).toBe(0);
    expect(r.match_status).toBe('unbilled');
  });

  it('matches on the pre-tax value, ignoring PPN on the bill', async () => {
    const { po } = await setup('5');
    await bill(po, '5', 55.5, 5.5); // gross 55.50, of which 5.50 PPN → net 50 matches received 50
    const r = await register(po);
    expect(Number(r.billed)).toBe(55.5);
    expect(Number(r.billed_net)).toBe(50);
    expect(Number(r.variance)).toBe(0);
    expect(r.match_status).toBe('matched');
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function makeLot(o: {
  product: string;
  wh: string;
  code: string;
  qty: number;
  unit?: string;
  status?: string;
  expiryDays?: number | null;
  cost?: number | null;
}): Promise<void> {
  await q(
    `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,unit_cost,expiry_date)
     values($1,'product',$2,$3,$4,$5,$6,$7,
            case when $8::int is null then null else current_date + $8::int end)`,
    [o.code, o.product, o.wh, o.qty, o.unit ?? 'g', o.status ?? 'available', o.cost ?? null, o.expiryDays ?? null],
  );
}

type Alloc = { lot_id: string; take_qty: string; lot_unit: string; lot_unit_cost: string | null };
const allocate = (product: string, wh: string, qty: number, unit = 'g') =>
  q<Alloc>(
    `select lot_id, take_qty, lot_unit, lot_unit_cost from fefo_allocate('product',null,$1,$2,$3,$4)`,
    [product, wh, qty, unit],
  );

describe('fefo_allocate — shared FEFO allocation plan', () => {
  it('allocates earliest-expiry first and takes the last needed lot partially', async () => {
    const wh = await createWarehouse('FA1');
    const prod = await createProduct('FA-P1', 'g');
    await makeLot({ product: prod, wh, code: 'E1', qty: 100, expiryDays: 10 });
    await makeLot({ product: prod, wh, code: 'E2', qty: 50, expiryDays: 20 });
    await makeLot({ product: prod, wh, code: 'E3', qty: 30, expiryDays: 30 });

    const plan = await allocate(prod, wh, 120);
    expect(plan).toHaveLength(2); // E3 not needed
    expect(Number(plan[0].take_qty)).toBeCloseTo(100, 6); // E1 in full
    expect(Number(plan[1].take_qty)).toBeCloseTo(20, 6); // E2 partial

    const [e1] = await q(`select id from inventory_lots where lot_code='E1'`);
    expect(plan[0].lot_id).toBe(e1.id); // earliest expiry first
  });

  it('returns only what is available when the request exceeds stock (caller sees the shortfall)', async () => {
    const wh = await createWarehouse('FA2');
    const prod = await createProduct('FA-P2', 'g');
    await makeLot({ product: prod, wh, code: 'A', qty: 100 });
    await makeLot({ product: prod, wh, code: 'B', qty: 50 });
    await makeLot({ product: prod, wh, code: 'C', qty: 30 });

    const plan = await allocate(prod, wh, 500);
    expect(plan).toHaveLength(3);
    const total = plan.reduce((s, r) => s + Number(r.take_qty), 0);
    expect(total).toBeCloseTo(180, 6); // 180 < 500 → caller raises / backorders
  });

  it('draws only available, in-warehouse, unexpired lots', async () => {
    const wh = await createWarehouse('FA3');
    const wh2 = await createWarehouse('FA3B');
    const prod = await createProduct('FA-P3', 'g');
    await makeLot({ product: prod, wh, code: 'OK', qty: 40 });
    await makeLot({ product: prod, wh, code: 'QUAR', qty: 100, status: 'quarantine' });
    await makeLot({ product: prod, wh, code: 'EXP', qty: 100, expiryDays: -1 });
    await makeLot({ product: prod, wh: wh2, code: 'OTHERWH', qty: 100 });

    const plan = await allocate(prod, wh, 1000);
    expect(plan).toHaveLength(1);
    expect(Number(plan[0].take_qty)).toBeCloseTo(40, 6);
  });
});

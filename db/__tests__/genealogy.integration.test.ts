import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  pool,
  q,
  truncateAll,
  createWarehouse,
  createRawMaterial,
  createProduct,
  createRawLot,
} from './helpers';

const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function buildLineage() {
  const wh = await createWarehouse();
  const mat = await createRawMaterial({ sku: 'M-TRACE' });
  const prod = await createProduct('FG-TRACE');

  const lotSoon = await createRawLot({
    materialId: mat, warehouseId: wh, lotCode: 'RAW-SOON', qty: 600, expiry: isoDay(10),
  });
  const lotLate = await createRawLot({
    materialId: mat, warehouseId: wh, lotCode: 'RAW-LATE', qty: 1000, expiry: isoDay(60),
  });

  const [fml] = await q(`insert into formulas(code,name) values('FT','FT') returning id`);
  const [fv] = await q(
    `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
    [fml.id],
  );
  const [po] = await q(
    `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
     values('PO-TRACE',$1,$2,$3,1000,'g') returning id`,
    [prod, fv.id, wh],
  );
  await q(
    `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
     values($1,$2,700,'g')`,
    [po.id, mat],
  );
  const [{ complete_production_order: finished }] = await q(
    `select complete_production_order($1,'FG-LOT-TRACE',null)`,
    [po.id],
  );
  return { lotSoon, lotLate, finished };
}

describe('genealogy traversal', () => {
  it('traces a finished lot back to its raw ancestors with consumed quantities', async () => {
    const { finished } = await buildLineage();
    const ancestors = await q(
      `select lot_code, depth, quantity from trace_lot_ancestors($1) order by quantity desc`,
      [finished],
    );
    expect(ancestors.map((a) => a.lot_code)).toEqual(['RAW-SOON', 'RAW-LATE']);
    expect(ancestors.every((a) => a.depth === 1)).toBe(true);
    expect(ancestors.map((a) => Number(a.quantity))).toEqual([600, 100]);
  });

  it('traces a raw lot forward to the finished lots it ended up in', async () => {
    const { lotSoon, lotLate, finished } = await buildLineage();

    const fromSoon = await q(`select lot_id, lot_code from trace_lot_descendants($1)`, [lotSoon]);
    expect(fromSoon.map((r) => r.lot_id)).toEqual([finished]);
    expect(fromSoon[0].lot_code).toBe('FG-LOT-TRACE');

    const fromLate = await q(`select lot_id from trace_lot_descendants($1)`, [lotLate]);
    expect(fromLate.map((r) => r.lot_id)).toEqual([finished]);
  });

  it('returns nothing for a lot with no genealogy', async () => {
    const wh = await createWarehouse('WH-ORPHAN');
    const mat = await createRawMaterial({ sku: 'M-ORPHAN' });
    const orphan = await createRawLot({ materialId: mat, warehouseId: wh, lotCode: 'ORPHAN', qty: 10 });
    const ancestors = await q(`select * from trace_lot_ancestors($1)`, [orphan]);
    expect(ancestors.length).toBe(0);
  });
});

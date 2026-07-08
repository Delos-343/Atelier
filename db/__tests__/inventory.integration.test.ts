import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  pool,
  q,
  truncateAll,
  createWarehouse,
  createRawMaterial,
  createProduct,
  createRawLot,
  onHand,
  lotStatus,
  reconcile,
} from './helpers';

const today = () => new Date();
const isoDay = (offsetDays: number) => {
  const d = today();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

describe('post_movement — integrity guards', () => {
  it('refuses to drive stock negative', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-NEG' });
    const lot = await createRawLot({ materialId: mat, warehouseId: wh, lotCode: 'L1', qty: 5 });

    await expect(
      q(`select post_movement($1,'issue',$2,'g',null,null,null)`, [lot, -10]),
    ).rejects.toThrow(/insufficient stock/);

    expect(Number(await onHand(lot))).toBe(5); // unchanged
    expect(await reconcile(lot)).toBe(true);
  });

  it('refuses to issue from an expired lot', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-EXP' });
    const lot = await createRawLot({
      materialId: mat,
      warehouseId: wh,
      lotCode: 'L-EXP',
      qty: 100,
      expiry: isoDay(-1),
    });
    await expect(
      q(`select post_movement($1,'issue',$2,'g',null,null,null)`, [lot, -1]),
    ).rejects.toThrow(/expired/);
  });

  it('refuses to issue from a quarantined lot', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-QUA' });
    const lot = await createRawLot({
      materialId: mat,
      warehouseId: wh,
      lotCode: 'L-QUA',
      qty: 100,
      status: 'quarantine',
    });
    await expect(
      q(`select post_movement($1,'issue',$2,'g',null,null,null)`, [lot, -1]),
    ).rejects.toThrow(/status quarantine/);
  });

  it('keeps the reconciliation invariant across mixed movements', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-REC' });
    const lot = await createRawLot({ materialId: mat, warehouseId: wh, lotCode: 'L-REC', qty: 100 });
    await q(`select post_movement($1,'adjustment',$2,'g',null,null,null)`, [lot, 25]);
    await q(`select post_movement($1,'issue',$2,'g',null,null,null)`, [lot, -40]);
    expect(Number(await onHand(lot))).toBe(85);
    expect(await reconcile(lot)).toBe(true);
  });
});

describe('complete_production_order — FEFO + genealogy (atomic)', () => {
  it('consumes earliest-expiry lots first and records full genealogy', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-FEFO' });
    const prod = await createProduct('FG-1');

    // two lots: earlier expiry should be drained first
    const lotSoon = await createRawLot({
      materialId: mat, warehouseId: wh, lotCode: 'SOON', qty: 600, expiry: isoDay(10),
    });
    const lotLate = await createRawLot({
      materialId: mat, warehouseId: wh, lotCode: 'LATE', qty: 1000, expiry: isoDay(60),
    });

    // minimal formula version (required FK), planned consumption set directly
    const [fml] = await q(`insert into formulas(code,name) values('F1','F1') returning id`);
    const [fv] = await q(
      `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
      [fml.id],
    );
    const [po] = await q(
      `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
       values('PO-1',$1,$2,$3,1000,'g') returning id`,
      [prod, fv.id, wh],
    );
    await q(
      `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
       values($1,$2,700,'g')`,
      [po.id, mat],
    );

    const [{ complete_production_order: outLot }] = await q(
      `select complete_production_order($1,'FG-LOT-1',null)`,
      [po.id],
    );

    // FEFO: SOON fully drained (0, consumed), LATE down to 900
    expect(Number(await onHand(lotSoon))).toBe(0);
    expect(await lotStatus(lotSoon)).toBe('consumed');
    expect(Number(await onHand(lotLate))).toBe(900);

    // output lot exists, quarantined, full planned qty
    expect(Number(await onHand(outLot))).toBe(1000);
    expect(await lotStatus(outLot)).toBe('quarantine');

    // genealogy: two parents -> one child, quantities 600 + 100
    const edges = await q(
      `select parent_lot_id, quantity from lot_genealogy where child_lot_id=$1 order by quantity desc`,
      [outLot],
    );
    expect(edges.map((e) => Number(e.quantity))).toEqual([600, 100]);

    // every touched lot reconciles
    for (const l of [lotSoon, lotLate, outLot]) {
      expect(await reconcile(l)).toBe(true);
    }
  });

  it('rolls back entirely when a component is short (no partial consumption)', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-SHORT' });
    const prod = await createProduct('FG-2');
    const lot = await createRawLot({ materialId: mat, warehouseId: wh, lotCode: 'ONLY', qty: 100, expiry: isoDay(30) });

    const [fml] = await q(`insert into formulas(code,name) values('F2','F2') returning id`);
    const [fv] = await q(
      `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
      [fml.id],
    );
    const [po] = await q(
      `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
       values('PO-2',$1,$2,$3,500,'g') returning id`,
      [prod, fv.id, wh],
    );
    await q(
      `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
       values($1,$2,500,'g')`, // needs 500, only 100 available
      [po.id, mat],
    );

    await expect(
      q(`select complete_production_order($1,'FG-LOT-2',null)`, [po.id]),
    ).rejects.toThrow(/insufficient stock/);

    // nothing consumed, no output lot, PO still planned
    expect(Number(await onHand(lot))).toBe(100);
    expect(await reconcile(lot)).toBe(true);
    const products = await q(`select * from inventory_lots where item_type='product'`);
    expect(products.length).toBe(0);
    const [poRow] = await q(`select status from production_orders where id=$1`, [po.id]);
    expect(poRow.status).toBe('planned');
  });
});

describe('record_qc — release gating', () => {
  it('passing QC releases a quarantined finished lot to available', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('FG-3');
    const [lot] = await q(
      `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status)
       values('FG-Q','product',$1,$2,500,'g','quarantine') returning id`,
      [prod, wh],
    );
    await q(`select record_qc($1,'passed',0.95,80,'ok',null)`, [lot.id]);
    expect(await lotStatus(lot.id)).toBe('available');
  });

  it('failing QC rejects the lot', async () => {
    const wh = await createWarehouse();
    const prod = await createProduct('FG-4');
    const [lot] = await q(
      `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status)
       values('FG-F','product',$1,$2,500,'g','quarantine') returning id`,
      [prod, wh],
    );
    await q(`select record_qc($1,'failed',null,null,'off-spec',null)`, [lot.id]);
    expect(await lotStatus(lot.id)).toBe('rejected');
  });
});

describe('concurrency — row locks prevent lost updates / oversell', () => {
  it('100 concurrent issues of 1 unit each from a 100-unit lot all serialize correctly', async () => {
    const wh = await createWarehouse();
    const mat = await createRawMaterial({ sku: 'M-RACE' });
    const lot = await createRawLot({ materialId: mat, warehouseId: wh, lotCode: 'RACE', qty: 100 });

    const ops = Array.from({ length: 100 }, () =>
      pool.query(`select post_movement($1,'issue',-1,'g',null,null,null)`, [lot]),
    );
    const results = await Promise.allSettled(ops);
    const ok = results.filter((r) => r.status === 'fulfilled').length;

    expect(ok).toBe(100); // none lost, none over-issued
    expect(Number(await onHand(lot))).toBe(0);
    expect(await lotStatus(lot)).toBe('consumed');

    const [{ count }] = await q(`select count(*)::int as count from stock_movements where lot_id=$1`, [lot]);
    expect(count).toBe(101); // 1 receipt + 100 issues
    expect(await reconcile(lot)).toBe(true);
  });
});

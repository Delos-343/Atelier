import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct, createRawLot } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

/**
 * Material A is priced at 20.00 per kg. The order consumes 200 g of it, so the
 * material cost is 0.2 kg * 20.00 = 4.00, and with a 10 L output the unit cost is
 * 0.40 / L. Exercises unit conversion (g -> kg) in the roll-up.
 */
async function buildCompletedOrder() {
  const wh = await createWarehouse();
  const [mat] = await q(
    `insert into raw_materials(sku,name,category,base_unit,standard_cost)
     values('RMA','Material A','aroma_chemical','kg',20.0000) returning id`,
  );
  const prod = await createProduct('P1', 'l');
  await createRawLot({ materialId: mat.id, warehouseId: wh, lotCode: 'L1', qty: 1.0, unit: 'kg' });

  const [fml] = await q(`insert into formulas(code,name) values('F1','F1') returning id`);
  const [fv] = await q(
    `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
    [fml.id],
  );
  const [po] = await q(
    `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
     values('PO1',$1,$2,$3,10,'l') returning id`,
    [prod, fv.id, wh],
  );
  await q(
    `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
     values($1,$2,200,'g')`,
    [po.id, mat.id],
  );
  const [{ complete_production_order: outputLotId }] = await q(
    `select complete_production_order($1,'OUT-PO1',null)`,
    [po.id],
  );
  return { wh, mat: mat.id, po: po.id, outputLotId };
}

describe('production order costing', () => {
  it('rolls up actual material cost with unit conversion and freezes unit cost', async () => {
    const { po, outputLotId } = await buildCompletedOrder();

    const [lot] = await q(`select unit_cost from inventory_lots where id=$1`, [outputLotId]);
    expect(Number(lot.unit_cost)).toBeCloseTo(0.4, 6); // 4.00 total / 10 output

    const [cons] = await q(
      `select cost, quantity, unit from production_consumptions where production_order_id=$1`,
      [po],
    );
    expect(Number(cons.cost)).toBeCloseTo(4.0, 6);
    expect(Number(cons.quantity)).toBe(200);
    expect(cons.unit).toBe('g');

    const lines = await q(`select * from production_order_cost($1)`, [po]);
    expect(lines).toHaveLength(1);
    expect(lines[0].sku).toBe('RMA');
    expect(Number(lines[0].consumed_quantity)).toBe(200);
    expect(Number(lines[0].line_cost)).toBeCloseTo(4.0, 6);
  });

  it('freezes cost at completion — a later standard_cost change does not alter it', async () => {
    const { mat, po, outputLotId } = await buildCompletedOrder();

    await q(`update raw_materials set standard_cost = 50.0 where id=$1`, [mat]);

    const [lot] = await q(`select unit_cost from inventory_lots where id=$1`, [outputLotId]);
    expect(Number(lot.unit_cost)).toBeCloseTo(0.4, 6); // still the frozen value

    const lines = await q(`select * from production_order_cost($1)`, [po]);
    expect(Number(lines[0].line_cost)).toBeCloseTo(4.0, 6); // breakdown frozen too
  });

  it('values finished goods and unit-converted raw in dashboard_metrics', async () => {
    await buildCompletedOrder();

    const [m] = await q<{ j: { inventory: { value_raw: number; value_finished: number } } }>(
      `select dashboard_metrics() as j`,
    );
    expect(Number(m.j.inventory.value_finished)).toBeCloseTo(4.0, 6); // 10 L * 0.40
    expect(Number(m.j.inventory.value_raw)).toBeCloseTo(16.0, 6); // 0.8 kg remaining * 20.00
  });
});

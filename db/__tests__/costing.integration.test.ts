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

describe('costing depth — labor & overhead', () => {
  // An OPEN order: consumes 200 g of a 20.00/kg material (material cost 4.00) into a 10 L
  // output, left un-completed so each test can set rates + labor hours at completion.
  async function buildOpenOrder(tag: string) {
    const wh = await createWarehouse(`WH-${tag}`);
    const [mat] = await q(
      `insert into raw_materials(sku,name,category,base_unit,standard_cost)
       values($1,$1,'aroma_chemical','kg',20.0000) returning id`,
      [`RM-${tag}`],
    );
    const prod = await createProduct(`P-${tag}`, 'l');
    await createRawLot({ materialId: mat.id, warehouseId: wh, lotCode: `L-${tag}`, qty: 1.0, unit: 'kg' });
    const [fml] = await q(`insert into formulas(code,name) values($1,$1) returning id`, [`F-${tag}`]);
    const [fv] = await q(
      `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
      [fml.id],
    );
    const [po] = await q(
      `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
       values($1,$2,$3,$4,10,'l') returning id`,
      [`PO-${tag}`, prod, fv.id, wh],
    );
    await q(
      `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
       values($1,$2,200,'g')`,
      [po.id, mat.id],
    );
    return { wh, mat: mat.id, prod, po: po.id };
  }

  async function setRates(laborRate: number, overheadRate: number) {
    await q(
      `insert into costing_settings(id,labor_rate_per_hour,overhead_rate) values(true,$1,$2)
       on conflict(id) do update set labor_rate_per_hour=$1, overhead_rate=$2`,
      [laborRate, overheadRate],
    );
  }

  it('adds labor (hours × rate) and overhead (rate × prime cost) to the frozen unit cost', async () => {
    const { po } = await buildOpenOrder('D1');
    await setRates(10, 0.2); // 10.00/hr labor, 20% overhead
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-D1',null,$2)`,
      [po, 3], // 3 labor hours
    );
    // material 4.00, labor 3×10 = 30, overhead 0.2×(4+30) = 6.8, total 40.8, unit 40.8/10 = 4.08
    const [ord] = await q(
      `select material_cost, labor_cost, overhead_cost, labor_hours from production_orders where id=$1`,
      [po],
    );
    expect(Number(ord.material_cost)).toBeCloseTo(4.0, 6);
    expect(Number(ord.labor_cost)).toBeCloseTo(30.0, 6);
    expect(Number(ord.overhead_cost)).toBeCloseTo(6.8, 6);
    expect(Number(ord.labor_hours)).toBeCloseTo(3, 6);

    const [lot] = await q(`select unit_cost from inventory_lots where id=$1`, [lotId]);
    expect(Number(lot.unit_cost)).toBeCloseTo(4.08, 6);
  });

  it('applies overhead to prime cost (material + labor), not material alone', async () => {
    const { po } = await buildOpenOrder('D2');
    await setRates(10, 0.5); // 50% overhead
    await q(`select complete_production_order($1,'OUT-D2',null,$2)`, [po, 2]);
    // material 4, labor 20, prime 24 → overhead 0.5×24 = 12 (NOT 0.5×4 = 2)
    const [ord] = await q(`select overhead_cost from production_orders where id=$1`, [po]);
    expect(Number(ord.overhead_cost)).toBeCloseTo(12.0, 6);
  });

  it('keeps cost material-only when rates are zero, regardless of labor hours', async () => {
    const { po } = await buildOpenOrder('D3');
    await setRates(0, 0);
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-D3',null,$2)`,
      [po, 99], // hours ignored when the rate is zero
    );
    const [ord] = await q(
      `select material_cost, labor_cost, overhead_cost from production_orders where id=$1`,
      [po],
    );
    expect(Number(ord.material_cost)).toBeCloseTo(4.0, 6);
    expect(Number(ord.labor_cost)).toBeCloseTo(0, 6);
    expect(Number(ord.overhead_cost)).toBeCloseTo(0, 6);
    const [lot] = await q(`select unit_cost from inventory_lots where id=$1`, [lotId]);
    expect(Number(lot.unit_cost)).toBeCloseTo(0.4, 6); // 4.00 / 10, material only
  });

  it('rejects negative labor hours', async () => {
    const { po } = await buildOpenOrder('D4');
    await setRates(10, 0.2);
    await expect(
      q(`select complete_production_order($1,'OUT-D4',null,$2)`, [po, -1]),
    ).rejects.toThrow(/labor hours cannot be negative/i);
  });

  it('flows the loaded unit cost into shipment COGS', async () => {
    const { prod, wh, po } = await buildOpenOrder('D5');
    await setRates(10, 0.2);
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-D5',null,$2)`,
      [po, 3],
    );
    // release from quarantine so it can ship (QC would normally do this)
    await q(`update inventory_lots set status='available' where id=$1`, [lotId]);

    const [cust] = await q(`insert into customers(code,name) values('C-D5','Cust D5') returning id`);
    const [so] = await q(
      `select create_sales_order('SO-D5',$1,$2,current_date,
         $3::jsonb) as id`,
      [cust.id, wh, JSON.stringify([{ product_id: prod, quantity: 5, unit: 'l', unit_price: 9.0 }])],
    );
    await q(`update sales_orders set status='confirmed' where id=$1`, [so.id]);
    await q(`select ship_sales_order($1,null)`, [so.id]);

    // realized COGS = loaded unit cost 4.08 × 5 shipped = 20.40
    const [line] = await q(
      `select shipped_quantity, cogs from sales_order_lines where sales_order_id=$1`,
      [so.id],
    );
    expect(Number(line.shipped_quantity)).toBeCloseTo(5, 6);
    expect(Number(line.cogs)).toBeCloseTo(20.4, 6);
  });

  // ── per-product rate overrides ────────────────────────────────────────────
  async function setProductOverride(
    productId: string,
    laborRate: number | null,
    overheadRate: number | null,
  ) {
    await q(
      `insert into product_costing_rates(product_id,labor_rate_per_hour,overhead_rate)
       values($1,$2,$3)
       on conflict(product_id) do update set labor_rate_per_hour=$2, overhead_rate=$3`,
      [productId, laborRate, overheadRate],
    );
  }

  it('uses a per-product rate override in place of the plant-wide standard', async () => {
    const { po, prod } = await buildOpenOrder('OV1');
    await setRates(10, 0.2); // plant-wide
    await setProductOverride(prod, 20, 0.5); // this product costs more
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-OV1',null,$2)`,
      [po, 2], // 2 labor hours
    );
    // material 4, labor 2×20 = 40, prime 44, overhead 0.5×44 = 22, total 66, unit 6.6
    const [ord] = await q(
      `select labor_cost, overhead_cost from production_orders where id=$1`,
      [po],
    );
    expect(Number(ord.labor_cost)).toBeCloseTo(40.0, 6);
    expect(Number(ord.overhead_cost)).toBeCloseTo(22.0, 6);
    const [lot] = await q(`select unit_cost from inventory_lots where id=$1`, [lotId]);
    expect(Number(lot.unit_cost)).toBeCloseTo(6.6, 6);
  });

  it('inherits the plant-wide rate per-field when an override leaves it null', async () => {
    const { po, prod } = await buildOpenOrder('OV2');
    await setRates(10, 0.2); // plant-wide labor 10, overhead 20%
    await setProductOverride(prod, 20, null); // override labor only; overhead inherits
    await q(`select complete_production_order($1,'OUT-OV2',null,$2)`, [po, 2]);
    // labor 2×20 = 40 (override); overhead 0.2×(4+40) = 8.8 (inherited plant-wide)
    const [ord] = await q(
      `select labor_cost, overhead_cost from production_orders where id=$1`,
      [po],
    );
    expect(Number(ord.labor_cost)).toBeCloseTo(40.0, 6);
    expect(Number(ord.overhead_cost)).toBeCloseTo(8.8, 6);
  });

  it('falls back entirely to plant-wide rates when a product has no override', async () => {
    const { po } = await buildOpenOrder('OV3');
    await setRates(10, 0.2); // no product override inserted
    await q(`select complete_production_order($1,'OUT-OV3',null,$2)`, [po, 3]);
    // identical to the plant-wide case: labor 3×10 = 30, overhead 0.2×(4+30) = 6.8
    const [ord] = await q(
      `select labor_cost, overhead_cost from production_orders where id=$1`,
      [po],
    );
    expect(Number(ord.labor_cost)).toBeCloseTo(30.0, 6);
    expect(Number(ord.overhead_cost)).toBeCloseTo(6.8, 6);
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct, createRawLot } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

type Cert = 'valid' | 'expired' | null;

/**
 * An open order whose FORMULA VERSION carries one component (the material is on the
 * recipe, which is what the gate checks — not just the order). `cert` controls the
 * material's halal state: certified+unexpired, certified+expired, or left at the
 * fail-closed default of 'in_review'.
 */
async function buildOrderWithRecipe(tag: string, cert: Cert) {
  const wh = await createWarehouse(`WH-${tag}`);
  const [mat] = await q(
    `insert into raw_materials(sku,name,category,base_unit,standard_cost)
     values($1,$1,'aroma_chemical','kg',20.0000) returning id`,
    [`RM-${tag}`],
  );
  if (cert === 'valid') {
    await q(
      `update raw_materials
          set halal_status='certified', halal_cert_number=$2, halal_certifier='MUI',
              halal_cert_expiry=current_date + 365
        where id=$1`,
      [mat.id, `CERT-${tag}`],
    );
  } else if (cert === 'expired') {
    await q(
      `update raw_materials
          set halal_status='certified', halal_cert_number=$2, halal_certifier='MUI',
              halal_cert_expiry=current_date - 1
        where id=$1`,
      [mat.id, `CERT-${tag}`],
    );
  }
  const prod = await createProduct(`P-${tag}`, 'l');
  await createRawLot({ materialId: mat.id, warehouseId: wh, lotCode: `L-${tag}`, qty: 1.0, unit: 'kg' });
  const [fml] = await q(`insert into formulas(code,name) values($1,$1) returning id`, [`F-${tag}`]);
  const [fv] = await q(
    `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
    [fml.id],
  );
  // The material lives on the recipe — the gate reads the formula version's components.
  await q(
    `insert into formula_components(formula_version_id,raw_material_id,quantity,unit,sequence)
     values($1,$2,100,'g',1)`,
    [fv.id, mat.id],
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
  return { wh, mat: mat.id, prod, po: po.id, fv: fv.id };
}

describe('hard halal gate at production completion', () => {
  it('blocks completion when a recipe material is not certified, and names it', async () => {
    const { po, prod } = await buildOrderWithRecipe('HG1', null); // default in_review
    await expect(
      q(`select complete_production_order($1,'OUT-HG1',null,0)`, [po]),
    ).rejects.toThrow(/not halal-compliant/i);
    // and it names the offending sku
    await expect(
      q(`select complete_production_order($1,'OUT-HG1b',null,0)`, [po]),
    ).rejects.toThrow(/RM-HG1/);

    // clean no-op: nothing produced, order not completed
    const [ord] = await q(`select status from production_orders where id=$1`, [po]);
    expect(ord.status).not.toBe('completed');
    const [{ n }] = await q<{ n: string }>(
      `select count(*) n from inventory_lots where item_type='product' and product_id=$1`,
      [prod],
    );
    expect(Number(n)).toBe(0);
  });

  it('allows completion when the recipe material is certified and unexpired', async () => {
    const { po } = await buildOrderWithRecipe('HG2', 'valid');
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-HG2',null,0)`,
      [po],
    );
    expect(lotId).toBeTruthy();
    const [ord] = await q(`select status from production_orders where id=$1`, [po]);
    expect(ord.status).toBe('completed');
  });

  it('blocks completion when the certificate has expired', async () => {
    const { po } = await buildOrderWithRecipe('HG3', 'expired');
    await expect(
      q(`select complete_production_order($1,'OUT-HG3',null,0)`, [po]),
    ).rejects.toThrow(/not halal-compliant/i);
  });

  it('passes silently for an empty formula version (nothing to certify)', async () => {
    // No formula_components on this recipe → vacuously compliant, like the pre-gate tests.
    const wh = await createWarehouse('WH-HG4');
    const [mat] = await q(
      `insert into raw_materials(sku,name,category,base_unit,standard_cost)
       values('RM-HG4','RM-HG4','aroma_chemical','kg',20) returning id`,
    );
    const prod = await createProduct('P-HG4', 'l');
    await createRawLot({ materialId: mat.id, warehouseId: wh, lotCode: 'L-HG4', qty: 1.0, unit: 'kg' });
    const [fml] = await q(`insert into formulas(code,name) values('F-HG4','F-HG4') returning id`);
    const [fv] = await q(
      `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
      [fml.id],
    );
    const [po] = await q(
      `insert into production_orders(code,product_id,formula_version_id,warehouse_id,planned_quantity,unit)
       values('PO-HG4',$1,$2,$3,10,'l') returning id`,
      [prod, fv.id, wh],
    );
    await q(
      `insert into production_order_components(production_order_id,raw_material_id,planned_quantity,unit)
       values($1,$2,200,'g')`,
      [po.id, mat.id],
    );
    const [{ complete_production_order: lotId }] = await q(
      `select complete_production_order($1,'OUT-HG4',null,0)`,
      [po.id],
    );
    expect(lotId).toBeTruthy();
  });
});

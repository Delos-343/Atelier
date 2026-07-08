import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct, createRawLot } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const OPERATOR = '33333333-3333-3333-3333-333333333333';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

/** Run as a Supabase `authenticated` user with a given JWT subject. */
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

/** A completable production order whose recipe carries one NON-certified material. */
async function nonCompliantOrder(tag: string): Promise<{ po: string; prod: string; fv: string }> {
  const wh = await createWarehouse(`WH-${tag}`);
  const [mat] = await q(
    `insert into raw_materials(sku,name,category,base_unit,standard_cost)
     values($1,$1,'aroma_chemical','kg',20) returning id`,
    [`RM-${tag}`],
  ); // left at fail-closed default 'in_review'
  const prod = await createProduct(`P-${tag}`, 'l');
  await createRawLot({ materialId: mat.id, warehouseId: wh, lotCode: `L-${tag}`, qty: 1.0, unit: 'kg' });
  const [fml] = await q(`insert into formulas(code,name) values($1,$1) returning id`, [`F-${tag}`]);
  const [fv] = await q(
    `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
    [fml.id],
  );
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
  return { po: po.id, prod, fv: fv.id };
}

describe('logged admin override of the halal gate', () => {
  it('still blocks a non-compliant order when no override is requested', async () => {
    const { po } = await nonCompliantOrder('OV1');
    await expect(q(`select complete_production_order($1,'OUT-OV1',null,0)`, [po])).rejects.toThrow(
      /not halal-compliant/i,
    );
  });

  it('lets an admin complete with a reason, and records the override', async () => {
    await q(`insert into app_users(user_id, role) values($1,'admin')`, [ADMIN]);
    const { po, prod, fv } = await nonCompliantOrder('OV2');

    const lotId = await asUser(ADMIN, async (c) => {
      const r = await c.query(
        `select complete_production_order($1,'OUT-OV2',null,0,true,'  client waiver #42  ') as id`,
        [po],
      );
      return r.rows[0].id as string;
    });
    expect(lotId).toBeTruthy();

    const [ord] = await q(`select status from production_orders where id=$1`, [po]);
    expect(ord.status).toBe('completed');
    // the finished lot actually got produced (override let it proceed past the gate)
    const [{ n }] = await q<{ n: string }>(
      `select count(*) n from inventory_lots where item_type='product' and product_id=$1`,
      [prod],
    );
    expect(Number(n)).toBe(1);

    const rows = await q<{
      formula_version_id: string;
      reason: string;
      overridden_by: string;
      noncompliance: unknown[];
    }>(`select formula_version_id, reason, overridden_by, noncompliance from production_halal_overrides where production_order_id=$1`, [po]);
    expect(rows).toHaveLength(1);
    expect(rows[0].formula_version_id).toBe(fv);
    expect(rows[0].reason).toBe('client waiver #42'); // trimmed
    expect(rows[0].overridden_by).toBe(ADMIN); // captured from auth.uid()
    expect(Array.isArray(rows[0].noncompliance)).toBe(true);
    expect(rows[0].noncompliance.length).toBeGreaterThan(0); // snapshot of offending inputs
  });

  it('refuses the override for a non-admin, changing nothing', async () => {
    const { po, prod } = await nonCompliantOrder('OV3'); // OPERATOR not in app_users → viewer
    await expect(
      asUser(OPERATOR, (c) =>
        c.query(`select complete_production_order($1,'OUT-OV3',null,0,true,'i say so')`, [po]),
      ),
    ).rejects.toThrow(/administrator/i);

    const [ord] = await q(`select status from production_orders where id=$1`, [po]);
    expect(ord.status).not.toBe('completed');
    const [{ n }] = await q<{ n: string }>(
      `select count(*) n from production_halal_overrides where production_order_id=$1`,
      [po],
    );
    expect(Number(n)).toBe(0);
    const [{ lots }] = await q<{ lots: string }>(
      `select count(*) lots from inventory_lots where item_type='product' and product_id=$1`,
      [prod],
    );
    expect(Number(lots)).toBe(0);
  });

  it('requires a reason even for an admin', async () => {
    await q(`insert into app_users(user_id, role) values($1,'admin')`, [ADMIN]);
    const { po } = await nonCompliantOrder('OV4');
    await expect(
      asUser(ADMIN, (c) =>
        c.query(`select complete_production_order($1,'OUT-OV4',null,0,true,'   ')`, [po]),
      ),
    ).rejects.toThrow(/reason is required/i);
    const [{ n }] = await q<{ n: string }>(
      `select count(*) n from production_halal_overrides where production_order_id=$1`,
      [po],
    );
    expect(Number(n)).toBe(0);
  });
});

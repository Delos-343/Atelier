import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const VIEWER = '22222222-2222-2222-2222-222222222222';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

/** Run a function as a Supabase `authenticated` user with a given JWT subject. */
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

async function seed(): Promise<{ lotId: string }> {
  // seeded as the superuser pool connection (bypasses RLS)
  await q(`insert into app_users(user_id, role) values($1,'admin'),($2,'viewer')`, [ADMIN, VIEWER]);
  const [wh] = await q(`insert into warehouses(code,name) values('WH','WH') returning id`);
  const [mat] = await q(
    `insert into raw_materials(sku,name,category,base_unit) values('M','M','aroma_chemical','g') returning id`,
  );
  const [fml] = await q(`insert into formulas(code,name) values('F','F') returning id`);
  const [fv] = await q(
    `insert into formula_versions(formula_id,version_no,basis) values($1,1,'percent') returning id`,
    [fml.id],
  );
  await q(
    `insert into formula_components(formula_version_id,raw_material_id,quantity,unit) values($1,$2,100,'g')`,
    [fv.id, mat.id],
  );
  const [lot] = await q(
    `insert into inventory_lots(lot_code,item_type,raw_material_id,warehouse_id,quantity_on_hand,unit,status)
     values('L','raw',$1,$2,100,'g','available') returning id`,
    [mat.id, wh.id],
  );
  return { lotId: lot.id };
}

describe('RLS — read gating', () => {
  it('hides formulas from a viewer but shows master data', async () => {
    await seed();
    await asUser(VIEWER, async (c) => {
      const formulas = await c.query('select * from formulas');
      expect(formulas.rowCount).toBe(0); // trade secrets: viewer denied

      const warehouses = await c.query('select * from warehouses');
      expect(warehouses.rowCount).toBe(1); // master data readable
    });
  });

  it('shows formulas to an admin', async () => {
    await seed();
    await asUser(ADMIN, async (c) => {
      const formulas = await c.query('select * from formulas');
      expect(formulas.rowCount).toBe(1);
    });
  });
});

describe('RLS — the ledger is function-only', () => {
  it('blocks a direct ledger insert even for an admin', async () => {
    const { lotId } = await seed();
    await asUser(ADMIN, async (c) => {
      await expect(
        c.query(
          `insert into stock_movements(lot_id,movement_type,quantity,unit) values($1,'adjustment',5,'g')`,
          [lotId],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('allows the same change through the SECURITY DEFINER gateway', async () => {
    const { lotId } = await seed();
    await asUser(ADMIN, async (c) => {
      // direct write is blocked, but the audited function succeeds
      await c.query(`select post_movement($1,'adjustment',5,'g',null,null,null)`, [lotId]);
    });
    const [{ quantity_on_hand }] = await q(
      `select quantity_on_hand from inventory_lots where id=$1`,
      [lotId],
    );
    expect(Number(quantity_on_hand)).toBe(105);
  });
});

describe('RLS — write gating', () => {
  it('lets an admin write master data', async () => {
    await seed();
    await asUser(ADMIN, async (c) => {
      await c.query(
        `insert into raw_materials(sku,name,category,base_unit) values('M2','M2','solvent','ml')`,
      );
      const rows = await c.query(`select * from raw_materials where sku='M2'`);
      expect(rows.rowCount).toBe(1);
    });
  });

  it('forbids a viewer from writing master data', async () => {
    await seed();
    await asUser(VIEWER, async (c) => {
      await expect(
        c.query(`insert into raw_materials(sku,name,category,base_unit) values('M3','M3','water','ml')`),
      ).rejects.toThrow(/row-level security/);
    });
  });
});

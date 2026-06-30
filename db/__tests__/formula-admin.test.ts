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

async function seed(): Promise<{ m1: string; m2: string; fml: string }> {
  await q(`insert into app_users(user_id, role) values($1,'admin'),($2,'viewer')`, [ADMIN, VIEWER]);
  const [m1] = await q(
    `insert into raw_materials(sku,name,category,base_unit) values('M1','M1','aroma_chemical','g') returning id`,
  );
  const [m2] = await q(
    `insert into raw_materials(sku,name,category,base_unit) values('M2','M2','aroma_chemical','g') returning id`,
  );
  const [fml] = await q(`insert into formulas(code,name) values('F','F') returning id`);
  return { m1: m1.id, m2: m2.id, fml: fml.id };
}

const comp = (id: string, qty: number, seq = 0) => ({
  raw_material_id: id,
  quantity: qty,
  unit: 'g',
  sequence: seq,
});

const createVersion = (c: PoolClient, fml: string, basis: string, clone: string | null) =>
  c
    .query('select admin_create_formula_version($1,$2,$3) as id', [fml, basis, clone])
    .then((r) => r.rows[0].id as string);

const save = (c: PoolClient, vid: string, components: unknown[], lock: boolean) =>
  c.query('select admin_save_formula_version($1,$2::jsonb,$3)', [
    vid,
    JSON.stringify(components),
    lock,
  ]);

const isLocked = (c: PoolClient, vid: string) =>
  c
    .query('select is_locked from formula_versions where id=$1', [vid])
    .then((r) => r.rows[0].is_locked as boolean);

describe('formula admin RPCs', () => {
  it('auto-numbers versions and clones components from a source version', async () => {
    const { m1, m2, fml } = await seed();
    await asUser(ADMIN, async (c) => {
      const v1 = await createVersion(c, fml, 'percent', null);
      await save(c, v1, [comp(m1, 60, 0), comp(m2, 40, 1)], false);

      const v2 = await createVersion(c, fml, 'percent', v1);
      const agg = await c.query(
        'select count(*)::int n, coalesce(sum(quantity),0)::float s from formula_components where formula_version_id=$1',
        [v2],
      );
      expect(agg.rows[0].n).toBe(2);
      expect(agg.rows[0].s).toBe(100);

      const vn = await c.query('select version_no from formula_versions where id=$1', [v2]);
      expect(vn.rows[0].version_no).toBe(2);
    });
  });

  it('allows an off-100 draft but blocks locking until percent sums to 100, then freezes edits', async () => {
    const { m1, m2, fml } = await seed();
    await asUser(ADMIN, async (c) => {
      const v = await createVersion(c, fml, 'percent', null);
      await save(c, v, [comp(m1, 50, 0), comp(m2, 40, 1)], false); // draft @ 90 — fine
      expect(await isLocked(c, v)).toBe(false);

      await expect(save(c, v, [comp(m1, 50, 0), comp(m2, 40, 1)], true)).rejects.toThrow(/sum/i);
      expect(await isLocked(c, v)).toBe(false);

      await save(c, v, [comp(m1, 60, 0), comp(m2, 40, 1)], true); // @ 100 — locks
      expect(await isLocked(c, v)).toBe(true);

      await expect(save(c, v, [comp(m1, 60, 0)], false)).rejects.toThrow(/locked/i);
    });
  });

  it('blocks deleting a locked version but removes an unlocked one', async () => {
    const { m1, m2, fml } = await seed();
    await asUser(ADMIN, async (c) => {
      const locked = await createVersion(c, fml, 'percent', null);
      await save(c, locked, [comp(m1, 60, 0), comp(m2, 40, 1)], true);
      await expect(c.query('select admin_delete_formula_version($1)', [locked])).rejects.toThrow(
        /locked/i,
      );

      const draft = await createVersion(c, fml, 'mass', null);
      await c.query('select admin_delete_formula_version($1)', [draft]);
      const gone = await c.query('select 1 from formula_versions where id=$1', [draft]);
      expect(gone.rowCount).toBe(0);
    });
  });

  it('rejects a duplicate material within one version', async () => {
    const { m1, fml } = await seed();
    await asUser(ADMIN, async (c) => {
      const v = await createVersion(c, fml, 'percent', null);
      await expect(save(c, v, [comp(m1, 50, 0), comp(m1, 50, 1)], false)).rejects.toThrow();
    });
  });

  it('refuses non-admins', async () => {
    const { fml } = await seed();
    await expect(
      asUser(VIEWER, (c) => c.query('select admin_create_formula_version($1,$2,$3)', [fml, 'percent', null])),
    ).rejects.toThrow(/admin/i);
  });
});

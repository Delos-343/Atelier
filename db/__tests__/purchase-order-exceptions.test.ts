import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createRawMaterial } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';

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
  await q(`insert into app_users(user_id, role) values($1,'admin') on conflict do nothing`, [ADMIN]);
}
async function createSupplier(tag: string): Promise<string> {
  await seedRoles();
  const [s] = await q<{ id: string }>(`insert into suppliers(code,name,payment_terms_days) values($1,$1,30) returning id`, [`S-${tag}`]);
  return s.id;
}

/** A PO of 10 units at cost 5, fully received → ordered/received value 50; then billed `amount`. */
async function pricedPO(tag: string, billAmount: number | null): Promise<{ poId: string; supplierId: string }> {
  const sup = await createSupplier(tag);
  const wh = await createWarehouse(`WH-${tag}`);
  const rm = await createRawMaterial({ sku: `RM-${tag}`, unit: 'g' });
  const poId = await asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select create_purchase_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
      [`PO-${tag}`, sup, wh, JSON.stringify([{ raw_material_id: rm, quantity: 10, unit: 'g', unit_cost: 5 }])],
    );
    return rows[0].id;
  });
  const [line] = await q<{ id: string }>(`select id from purchase_order_lines where purchase_order_id=$1`, [poId]);
  await asUser(ADMIN, (c) =>
    c.query(`select receive_purchase_order($1,$2::jsonb)`, [poId, JSON.stringify([{ lineId: line.id, quantity: 10, lotCode: `LOT-${tag}` }])]),
  );
  if (billAmount !== null) {
    await asUser(ADMIN, (c) =>
      c.query(`select bill_purchase_order($1,$2,'2026-07-05',$3,null,null,0) as id`, [poId, `SUP-INV-${tag}`, billAmount]),
    );
  }
  return { poId, supplierId: sup };
}

interface Exc {
  purchase_order_id: string;
  code: string;
  supplier_id: string;
  variance: string;
  match_status: string;
}
async function exceptions(supplierId: string | null = null): Promise<Exc[]> {
  return q<Exc>(`select * from purchase_order_exceptions($1)`, [supplierId]);
}

describe('purchase order exceptions', () => {
  it('lists only over- and under-billed orders, largest gap first', async () => {
    await pricedPO('match', 50); // matched → excluded
    const over = await pricedPO('over', 60); // +10 over-billed
    const under = await pricedPO('under', 35); // −15 under-billed
    await pricedPO('unbilled', null); // unbilled → excluded

    const rows = await exceptions();
    expect(rows).toHaveLength(2);
    // ordered by |variance| desc: under (15) before over (10)
    expect(rows[0].purchase_order_id).toBe(under.poId);
    expect(rows[0].match_status).toBe('under_billed');
    expect(Number(rows[0].variance)).toBe(-15);
    expect(rows[1].purchase_order_id).toBe(over.poId);
    expect(rows[1].match_status).toBe('over_billed');
    expect(Number(rows[1].variance)).toBe(10);
  });

  it('excludes a matched order and an unbilled one', async () => {
    await pricedPO('m', 50); // matched
    await pricedPO('u', null); // unbilled
    const rows = await exceptions();
    expect(rows).toHaveLength(0);
  });

  it('filters to a single supplier when asked', async () => {
    const over = await pricedPO('sa', 60);
    await pricedPO('sb', 30); // a different supplier, also an exception

    const all = await exceptions();
    expect(all.length).toBe(2);
    const one = await exceptions(over.supplierId);
    expect(one).toHaveLength(1);
    expect(one[0].supplier_id).toBe(over.supplierId);
  });

  it('agrees with the register on the same purchase order', async () => {
    const over = await pricedPO('agree', 60);
    const [reg] = await q<{ variance: string; match_status: string }>(
      `select variance, match_status from purchase_order_register($1)`,
      [over.poId],
    );
    const [exc] = await exceptions(over.supplierId);
    expect(exc.match_status).toBe(reg.match_status);
    expect(Number(exc.variance)).toBe(Number(reg.variance));
  });
});

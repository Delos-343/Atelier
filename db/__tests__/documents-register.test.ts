import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const VIEWER = '22222222-2222-2222-2222-222222222222';

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
  await q(
    `insert into app_users(user_id, role) values($1,'admin'),($2,'viewer') on conflict do nothing`,
    [ADMIN, VIEWER],
  );
}

/** Create an order with a single priced line; returns its id, code, and customer name. */
async function makeOrder(tag: string, unitPrice = 100, quantity = 1) {
  await seedRoles();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,tax_exempt) values($1,$2,true) returning id`,
    [`C-${tag}`, `Cust ${tag}`],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
    [
      `SO-${tag}`,
      cust.id,
      wh,
      JSON.stringify([{ product_id: p, quantity, unit: 'ml', unit_price: unitPrice }]),
    ],
  );
  return { orderId: o.id, code: `SO-${tag}`, customerName: `Cust ${tag}` };
}

/** Issue a document of the given kind against an order (as ADMIN); returns its id. */
async function issue(kind: 'invoice' | 'packing_slip', orderId: string): Promise<string> {
  return asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select issue_document($1,$2,null) as id`, [
      kind,
      orderId,
    ]);
    return rows[0].id;
  });
}

/** The whole register, as a map keyed by issued_document_id. */
async function registerById(sub = ADMIN): Promise<Record<string, any>> {
  const rows = await asUser(sub, async (c) => (await c.query(`select * from issued_documents_register()`)).rows);
  return Object.fromEntries(rows.map((r: any) => [r.issued_document_id, r]));
}

describe('issued documents register', () => {
  it('lists every issued document across orders, with its order and customer', async () => {
    const a = await makeOrder('A');
    const b = await makeOrder('B');
    const invA = await issue('invoice', a.orderId);
    const psA = await issue('packing_slip', a.orderId);
    const invB = await issue('invoice', b.orderId);

    const byId = await registerById();
    expect(Object.keys(byId)).toHaveLength(3);

    expect(byId[invA].kind).toBe('invoice');
    expect(byId[invA].order_code).toBe('SO-A');
    expect(byId[invA].customer_name).toBe('Cust A');
    expect(byId[invA].document_number).toBe('INV-2026-00001');

    expect(byId[invB].order_code).toBe('SO-B');
    expect(byId[invB].document_number).toBe('INV-2026-00002');

    // A packing slip carries no monetary claim and no receivable state.
    expect(byId[psA].kind).toBe('packing_slip');
    expect(byId[psA].total).toBeNull();
    expect(byId[psA].payment_status).toBeNull();
  });

  it('summarizes send history and reuses the invoice receivable status', async () => {
    const a = await makeOrder('S', 100, 1);
    const inv = await issue('invoice', a.orderId);
    const ps = await issue('packing_slip', a.orderId);

    // Email the invoice twice (b@ last), then pay it partially.
    await asUser(ADMIN, (c) => c.query(`select record_document_email($1,'a@x.com','S','M')`, [inv]));
    await asUser(ADMIN, (c) => c.query(`select record_document_email($1,'b@x.com','S','M')`, [inv]));
    await asUser(ADMIN, (c) =>
      c.query(`select record_invoice_payment($1, 40.00, '2026-07-02', 'QRIS', null)`, [inv]),
    );

    const byId = await registerById();
    expect(byId[inv].email_count).toBe(2);
    expect(byId[inv].last_recipient).toBe('b@x.com'); // latest send
    expect(byId[inv].payment_status).toBe('partially_paid'); // reused from invoice_receivables()
    expect(Number(byId[inv].paid)).toBe(40);
    expect(Number(byId[inv].open)).toBe(60);

    // The packing slip was never emailed and has no payment state.
    expect(byId[ps].email_count).toBe(0);
    expect(byId[ps].last_recipient).toBeNull();
    expect(byId[ps].payment_status).toBeNull();
  });

  it('flags a voided document with its reason, and is readable by any signed-in user', async () => {
    const a = await makeOrder('V');
    const inv = await issue('invoice', a.orderId);
    const ps = await issue('packing_slip', a.orderId);
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1,'issued against the wrong order')`, [ps]));

    // The derivation is granted to authenticated (the register route gates admin);
    // a viewer can read it directly.
    const byId = await registerById(VIEWER);
    expect(Object.keys(byId)).toHaveLength(2);
    expect(byId[ps].voided).toBe(true);
    expect(byId[ps].void_reason).toBe('issued against the wrong order');
    expect(byId[inv].voided).toBe(false);
  });
});

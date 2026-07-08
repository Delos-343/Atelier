import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';
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

/** The PPN rate is a singleton and survives truncateAll, so each test sets it explicitly. */
async function setPpnRate(rate: number): Promise<void> {
  await q(`update tax_settings set ppn_rate = $1 where id = true`, [rate]);
}

interface OrderOpts {
  discountPct?: number;
  exempt?: boolean;
  unitPrice?: number;
  quantity?: number;
}

/** A customer (with the given tax treatment) and a one-line order. Returns the order id. */
async function makeOrder(tag: string, opts: OrderOpts = {}): Promise<string> {
  await q(`insert into app_users(user_id, role) values($1,'admin') on conflict do nothing`, [ADMIN]);
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,payment_terms_days,discount_pct,tax_exempt)
     values($1,$2,30,$3,$4) returning id`,
    [`C-${tag}`, `Cust ${tag}`, opts.discountPct ?? 0, opts.exempt ?? false],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-06-01',$4::jsonb) as id`,
    [
      `SO-${tag}`,
      cust.id,
      wh,
      JSON.stringify([
        { product_id: p, quantity: opts.quantity ?? 1, unit: 'ml', unit_price: opts.unitPrice ?? 100 },
      ]),
    ],
  );
  return o.id;
}

async function preview(orderId: string): Promise<Record<string, string>> {
  const [r] = await q<{ d: Record<string, string> }>(`select invoice_document($1) as d`, [orderId]);
  return r.d;
}

async function issue(orderId: string): Promise<string> {
  return asUser(
    ADMIN,
    async (c) =>
      (await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [orderId])).rows[0]
        .id,
  );
}

describe('tax & pricing', () => {
  it('computes subtotal, per-customer discount, taxable base, PPN, and total', async () => {
    await setPpnRate(11);
    const o = await makeOrder('BRK', { discountPct: 10, unitPrice: 100, quantity: 10 });
    const d = await preview(o);
    expect(Number(d.subtotal)).toBe(1000);
    expect(Number(d.discountPct)).toBe(10);
    expect(Number(d.discountAmount)).toBe(100);
    expect(Number(d.taxableAmount)).toBe(900);
    expect(Number(d.taxRate)).toBe(11);
    expect(Number(d.taxAmount)).toBe(99);
    expect(Number(d.total)).toBe(999);
  });

  it('zero-rates an exempt customer regardless of the house rate', async () => {
    await setPpnRate(11);
    const o = await makeOrder('EXM', { discountPct: 10, exempt: true, unitPrice: 100, quantity: 10 });
    const d = await preview(o);
    expect(Number(d.taxRate)).toBe(0);
    expect(Number(d.taxAmount)).toBe(0);
    expect(Number(d.total)).toBe(900); // 1000 subtotal − 100 discount, no tax
  });

  it('taxes the full subtotal when the customer has no discount', async () => {
    await setPpnRate(11);
    const o = await makeOrder('NOD', { unitPrice: 100, quantity: 10 });
    const d = await preview(o);
    expect(Number(d.discountAmount)).toBe(0);
    expect(Number(d.taxableAmount)).toBe(1000);
    expect(Number(d.taxAmount)).toBe(110);
    expect(Number(d.total)).toBe(1110);
  });

  it('carries the tax-inclusive total into the issued invoice and the receivable', async () => {
    await setPpnRate(11);
    const o = await makeOrder('REC', { discountPct: 10, unitPrice: 100, quantity: 10 });
    const docId = await issue(o);
    const [doc] = await q<{ total: string; snap: Record<string, string> }>(
      `select total, snapshot as snap from issued_documents where id=$1`,
      [docId],
    );
    expect(Number(doc.total)).toBe(999);
    expect(Number(doc.snap.taxAmount)).toBe(99);

    const rec = await asUser(
      ADMIN,
      async (c) => (await c.query(`select * from invoice_receivables($1)`, [o])).rows,
    );
    expect(rec).toHaveLength(1);
    expect(Number(rec[0].total)).toBe(999);
    expect(Number(rec[0].open)).toBe(999);
  });

  it('freezes the rate and the discount at issue time', async () => {
    await setPpnRate(11);
    const o = await makeOrder('FRZ', { discountPct: 10, unitPrice: 100, quantity: 10 });
    const docId = await issue(o);

    // Change the house rate and the customer's discount AFTER issuing.
    await setPpnRate(12);
    await q(`update customers set discount_pct = 20 where code = 'C-FRZ'`);

    // The issued snapshot keeps the day-it-was-cut figures.
    const [doc] = await q<{ snap: Record<string, string>; total: string }>(
      `select snapshot as snap, total from issued_documents where id=$1`,
      [docId],
    );
    expect(Number(doc.snap.taxRate)).toBe(11);
    expect(Number(doc.snap.discountPct)).toBe(10);
    expect(Number(doc.total)).toBe(999);

    // A fresh preview of the same order reflects the new world.
    const d = await preview(o);
    expect(Number(d.taxRate)).toBe(12);
    expect(Number(d.discountPct)).toBe(20);
    expect(Number(d.total)).toBe(896); // 1000 − 200 discount = 800 taxable, +12% = 896
  });
});

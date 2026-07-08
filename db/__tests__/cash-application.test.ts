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

/** One tax-exempt customer, so an invoice's total is exactly its priced lines. */
async function makeCustomer(tag: string): Promise<string> {
  await seedRoles();
  const [c] = await q<{ id: string }>(
    `insert into customers(code,name,tax_exempt) values($1,$1,true) returning id`,
    [`C-${tag}`],
  );
  return c.id;
}

interface Inv {
  docId: string;
  orderId: string;
}

/** Issue one invoice of value unitPrice×quantity for a customer. */
async function invoiceFor(custId: string, tag: string, unitPrice: number, quantity: number): Promise<Inv> {
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
    [`SO-${tag}`, custId, wh, JSON.stringify([{ product_id: p, quantity, unit: 'ml', unit_price: unitPrice }])],
  );
  const docId = await asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id]);
    return rows[0].id;
  });
  return { docId, orderId: o.id };
}

/** The receivable row for an order (open / paid / status). */
async function receivable(orderId: string) {
  const [row] = await q<any>(`select * from invoice_receivables($1)`, [orderId]);
  return row;
}

async function applyReceipt(
  custId: string,
  amount: number,
  allocations: { invoiceId: string; amount: number }[],
  opts: { date?: string; method?: string; reference?: string; as?: string } = {},
): Promise<string> {
  return asUser(opts.as ?? ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select apply_customer_receipt($1,$2,$3,$4,$5,$6::jsonb) as id`,
      [custId, opts.date ?? '2026-07-05', amount, opts.method ?? null, opts.reference ?? null, JSON.stringify(allocations)],
    );
    return rows[0].id;
  });
}

async function receipt(custId: string) {
  const [row] = await q<any>(`select * from list_customer_receipts($1)`, [custId]);
  return row;
}

describe('cash application', () => {
  it('applies one receipt across several invoices, clearing each and reconciling with the receivable', async () => {
    const cust = await makeCustomer('clr');
    const a = await invoiceFor(cust, 'a', 100, 1);
    const b = await invoiceFor(cust, 'b', 60, 1);
    const d = await invoiceFor(cust, 'd', 40, 1);

    const id = await applyReceipt(cust, 200, [
      { invoiceId: a.docId, amount: 100 },
      { invoiceId: b.docId, amount: 60 },
      { invoiceId: d.docId, amount: 40 },
    ], { method: 'Bank transfer', reference: 'TRX-1' });
    expect(id).toBeTruthy();

    // Each invoice is settled — and the paid figure comes from invoice_receivables,
    // proving the receipt's applications are ordinary payments the derivation counts.
    for (const inv of [a, b, d]) {
      const r = await receivable(inv.orderId);
      expect(Number(r.open)).toBe(0);
      expect(r.status).toBe('paid');
    }
    expect(Number((await receivable(a.orderId)).paid)).toBe(100);

    const rc = await receipt(cust);
    expect(Number(rc.amount)).toBe(200);
    expect(Number(rc.applied)).toBe(200);
    expect(Number(rc.unapplied)).toBe(0);
    expect(Number(rc.application_count)).toBe(3);
  });

  it('holds the unapplied remainder of a receipt on account', async () => {
    const cust = await makeCustomer('acct');
    const a = await invoiceFor(cust, 'a', 100, 1);
    const b = await invoiceFor(cust, 'b', 60, 1);

    // 250 received; only 130 applied (a in full, b in part) — 120 left on account.
    await applyReceipt(cust, 250, [
      { invoiceId: a.docId, amount: 100 },
      { invoiceId: b.docId, amount: 30 },
    ]);

    expect((await receivable(a.orderId)).status).toBe('paid');
    const rb = await receivable(b.orderId);
    expect(rb.status).toBe('partially_paid');
    expect(Number(rb.open)).toBe(30);

    const rc = await receipt(cust);
    expect(Number(rc.applied)).toBe(130);
    expect(Number(rc.unapplied)).toBe(120);
  });

  it("applies a receipt's remaining balance to more invoices later", async () => {
    const cust = await makeCustomer('later');
    const a = await invoiceFor(cust, 'a', 100, 1);
    const b = await invoiceFor(cust, 'b', 60, 1);

    const id = await applyReceipt(cust, 200, [{ invoiceId: a.docId, amount: 100 }]);
    expect(Number((await receipt(cust)).unapplied)).toBe(100);

    // draw down the remaining 100 against b (60) — 40 stays on account
    await asUser(ADMIN, (c) =>
      c.query(`select apply_receipt($1,$2::jsonb)`, [id, JSON.stringify([{ invoiceId: b.docId, amount: 60 }])]),
    );

    expect((await receivable(b.orderId)).status).toBe('paid');
    const rc = await receipt(cust);
    expect(Number(rc.applied)).toBe(160);
    expect(Number(rc.unapplied)).toBe(40);
  });

  it('refuses an allocation beyond an invoice open balance', async () => {
    const cust = await makeCustomer('over1');
    const a = await invoiceFor(cust, 'a', 100, 1);
    await expect(
      applyReceipt(cust, 500, [{ invoiceId: a.docId, amount: 150 }]),
    ).rejects.toThrow(/exceeds its open balance/i);
    // nothing was banked — the whole call rolled back
    expect(await receipt(cust)).toBeUndefined();
  });

  it('refuses allocations that total more than the receipt', async () => {
    const cust = await makeCustomer('over2');
    const a = await invoiceFor(cust, 'a', 100, 1);
    const b = await invoiceFor(cust, 'b', 60, 1);
    await expect(
      applyReceipt(cust, 100, [
        { invoiceId: a.docId, amount: 100 },
        { invoiceId: b.docId, amount: 60 },
      ]),
    ).rejects.toThrow(/unapplied balance/i);
    expect(await receipt(cust)).toBeUndefined();
  });

  it('deletes a receipt, reversing every application so the invoices reopen', async () => {
    const cust = await makeCustomer('rev');
    const a = await invoiceFor(cust, 'a', 100, 1);
    const b = await invoiceFor(cust, 'b', 60, 1);

    const id = await applyReceipt(cust, 160, [
      { invoiceId: a.docId, amount: 100 },
      { invoiceId: b.docId, amount: 60 },
    ]);
    expect((await receivable(a.orderId)).status).toBe('paid');

    await asUser(ADMIN, (c) => c.query(`select delete_receipt($1)`, [id]));

    for (const inv of [a, b]) {
      const r = await receivable(inv.orderId);
      expect(Number(r.open)).toBe(inv === a ? 100 : 60);
      expect(r.status).toBe('open');
    }
    expect(await receipt(cust)).toBeUndefined();
  });

  it('is admin-only and select-only: a viewer cannot apply a receipt or write the tables directly', async () => {
    const cust = await makeCustomer('rls');
    const a = await invoiceFor(cust, 'a', 100, 1);

    await expect(
      applyReceipt(cust, 100, [{ invoiceId: a.docId, amount: 50 }], { as: VIEWER }),
    ).rejects.toThrow(/administrator/i);

    await expect(
      asUser(VIEWER, (c) => c.query(`insert into customer_receipts(customer_id,amount) values($1,50)`, [cust])),
    ).rejects.toThrow();

    // and no receipt slipped through
    expect(await receipt(cust)).toBeUndefined();
  });
});

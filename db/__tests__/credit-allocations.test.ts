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

/** A fresh customer with one order (single priced line). */
async function makeOrder(tag: string, unitPrice = 10, qty = 10) {
  await seedRoles();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(`insert into customers(code,name,tax_exempt) values($1,$2,true) returning id`, [
    `C-${tag}`,
    `Cust ${tag}`,
  ]);
  const [o] = await q<{ id: string }>(`select create_sales_order($1,$2,$3,'2026-04-01',$4::jsonb) as id`, [
    `SO-${tag}`,
    cust.id,
    wh,
    JSON.stringify([{ product_id: p, quantity: qty, unit: 'ml', unit_price: unitPrice }]),
  ]);
  return { orderId: o.id, customerId: cust.id, productId: p };
}

/** Another order for an existing customer (to give a customer a second invoice). */
async function makeOrderForCustomer(tag: string, customerId: string, unitPrice = 10, qty = 10) {
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [o] = await q<{ id: string }>(`select create_sales_order($1,$2,$3,'2026-04-01',$4::jsonb) as id`, [
    `SO-${tag}`,
    customerId,
    wh,
    JSON.stringify([{ product_id: p, quantity: qty, unit: 'ml', unit_price: unitPrice }]),
  ]);
  return { orderId: o.id, productId: p };
}

async function issueInvoice(orderId: string): Promise<string> {
  return asUser(ADMIN, async (c) => (await c.query(`select issue_document('invoice',$1,null) as id`, [orderId])).rows[0].id);
}

async function issuePackingSlip(orderId: string): Promise<string> {
  return asUser(ADMIN, async (c) => (await c.query(`select issue_document('packing_slip',$1,null) as id`, [orderId])).rows[0].id);
}

/** Build a credit note for an order (credit = qty × unitPrice) and issue it; returns the issued-document id. */
async function issueCreditNote(orderId: string, productId: string, tag: string, unitPrice = 10, qty = 4): Promise<string> {
  const [line] = await q<{ id: string }>(`select id from sales_order_lines where sales_order_id=$1 limit 1`, [orderId]);
  const [cn] = await q<{ id: string }>(
    `insert into credit_notes(code, sales_order_id, credit_date) values($1,$2,'2026-05-01') returning id`,
    [`CN-${tag}`, orderId],
  );
  await q(
    `insert into credit_note_lines(credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price)
     values($1,$2,$3,$4,'ml',$5)`,
    [cn.id, line.id, productId, qty, unitPrice],
  );
  return asUser(ADMIN, async (c) => (await c.query(`select issue_document('credit_note',null,$1) as id`, [cn.id])).rows[0].id);
}

async function allocate(creditNoteId: string, invoiceId: string, amount: number, sub = ADMIN) {
  return asUser(sub, (c) =>
    c.query(`select allocate_credit_note($1,$2,$3,'2026-05-02') as id`, [creditNoteId, invoiceId, amount]),
  );
}

async function receivablesById(orderId: string | null = null): Promise<Record<string, any>> {
  const rows = await asUser(ADMIN, async (c) =>
    (await c.query(`select * from invoice_receivables($1)`, [orderId])).rows,
  );
  return Object.fromEntries(rows.map((r: any) => [r.issued_document_id, r]));
}

async function creditBalancesById(orderId: string | null = null): Promise<Record<string, any>> {
  const rows = await asUser(ADMIN, async (c) =>
    (await c.query(`select * from credit_note_balances($1, null)`, [orderId])).rows,
  );
  return Object.fromEntries(rows.map((r: any) => [r.issued_document_id, r]));
}

describe('credit-note allocation', () => {
  it('applies a credit note to an invoice, reducing its open balance, and reflects it in both derivations', async () => {
    const o = await makeOrder('A', 10, 10); // invoice total 100
    const inv = await issueInvoice(o.orderId);
    const cn = await issueCreditNote(o.orderId, o.productId, 'A', 10, 4); // credit total 40

    await allocate(cn, inv, 40);

    const recv = await receivablesById(o.orderId);
    expect(Number(recv[inv].paid)).toBe(0);
    expect(Number(recv[inv].allocated)).toBe(40);
    expect(Number(recv[inv].open)).toBe(60); // 100 − 0 paid − 40 credit
    expect(recv[inv].status).toBe('partially_paid');

    const cb = await creditBalancesById(o.orderId);
    expect(Number(cb[cn].total)).toBe(40);
    expect(Number(cb[cn].allocated)).toBe(40);
    expect(Number(cb[cn].remaining)).toBe(0);
  });

  it('a credit that covers the invoice settles it (status paid, open 0)', async () => {
    const o = await makeOrder('B', 10, 10); // invoice 100
    const inv = await issueInvoice(o.orderId);
    const cn = await issueCreditNote(o.orderId, o.productId, 'B', 10, 10); // credit 100

    await allocate(cn, inv, 100);

    const recv = await receivablesById(o.orderId);
    expect(Number(recv[inv].open)).toBe(0);
    expect(Number(recv[inv].allocated)).toBe(100);
    expect(recv[inv].status).toBe('paid');
  });

  it('enforces the allocation guards', async () => {
    const o = await makeOrder('G', 10, 10); // invoice 100
    const inv = await issueInvoice(o.orderId);
    const cn = await issueCreditNote(o.orderId, o.productId, 'G', 10, 4); // credit 40

    // over-allocate the credit note (remaining 40)
    await expect(allocate(cn, inv, 41)).rejects.toThrow(/exceeds credit note/i);

    // a credit note can only be applied to an invoice
    const ps = await issuePackingSlip(o.orderId);
    await expect(allocate(cn, ps, 10)).rejects.toThrow(/only be applied to an invoice/i);

    // different customer
    const o2 = await makeOrder('H', 10, 10);
    const cn2 = await issueCreditNote(o2.orderId, o2.productId, 'H', 10, 4);
    await expect(allocate(cn2, inv, 10)).rejects.toThrow(/different customers/i);

    // non-admin
    await expect(allocate(cn, inv, 10, VIEWER)).rejects.toThrow(/administrator/i);

    // over the invoice's open balance: pay 80 (open 20), then a 40 credit overflows
    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 80.00, '2026-05-02', 'QRIS', null)`, [inv]));
    await expect(allocate(cn, inv, 40)).rejects.toThrow(/exceeds the open balance/i);

    // a voided invoice takes no credit
    const o3 = await makeOrder('K', 10, 10);
    const inv3 = await issueInvoice(o3.orderId);
    const cn3 = await issueCreditNote(o3.orderId, o3.productId, 'K', 10, 4);
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1,'issued in error')`, [inv3]));
    await expect(allocate(cn3, inv3, 10)).rejects.toThrow(/voided/i);
  });

  it('splits a credit across invoices and reopens balances when an allocation is removed', async () => {
    const o1 = await makeOrder('M', 10, 10); // customer M, invoice1 100
    const inv1 = await issueInvoice(o1.orderId);
    const o2 = await makeOrderForCustomer('M2', o1.customerId, 10, 5); // same customer, invoice2 50
    const inv2 = await issueInvoice(o2.orderId);
    const cn = await issueCreditNote(o1.orderId, o1.productId, 'M', 10, 4); // credit 40

    await allocate(cn, inv1, 25);
    await allocate(cn, inv2, 15);
    // credit is now fully used
    await expect(allocate(cn, inv1, 1)).rejects.toThrow(/exceeds credit note/i);

    let recv = await receivablesById();
    expect(Number(recv[inv1].open)).toBe(75);
    expect(Number(recv[inv2].open)).toBe(35);
    let cb = await creditBalancesById();
    expect(Number(cb[cn].remaining)).toBe(0);

    // remove the inv2 allocation → both the invoice and the credit reopen
    const [al2] = await q<{ id: string }>(`select id from credit_allocations where invoice_id=$1`, [inv2]);
    await asUser(ADMIN, (c) => c.query(`select delete_credit_allocation($1)`, [al2.id]));

    recv = await receivablesById();
    expect(Number(recv[inv2].open)).toBe(50); // reopened in full
    cb = await creditBalancesById();
    expect(Number(cb[cn].remaining)).toBe(15); // credit freed
  });

  it('locks the allocations table against direct client writes', async () => {
    const o = await makeOrder('W', 10, 10);
    const inv = await issueInvoice(o.orderId);
    const cn = await issueCreditNote(o.orderId, o.productId, 'W', 10, 4);

    // reads are allowed
    await asUser(VIEWER, (c) => c.query(`select * from credit_allocations`));
    // direct writes are not
    await expect(
      asUser(ADMIN, (c) =>
        c.query(`insert into credit_allocations(credit_note_id, invoice_id, amount) values($1,$2,10)`, [cn, inv]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

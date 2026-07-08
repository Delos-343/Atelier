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

/** A tax-exempt customer with one order whose invoice total is qty × unitPrice. */
async function makeOrder(tag: string, unitPrice: number, qty = 1) {
  await seedRoles();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,tax_exempt) values($1,$1,true) returning id`,
    [`C-${tag}`],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-04-01',$4::jsonb) as id`,
    [`SO-${tag}`, cust.id, wh, JSON.stringify([{ product_id: p, quantity: qty, unit: 'ml', unit_price: unitPrice }])],
  );
  return { orderId: o.id, customerId: cust.id, productId: p };
}

async function orderForCustomer(tag: string, customerId: string, unitPrice: number, qty = 1) {
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-04-01',$4::jsonb) as id`,
    [`SO-${tag}`, customerId, wh, JSON.stringify([{ product_id: p, quantity: qty, unit: 'ml', unit_price: unitPrice }])],
  );
  return { orderId: o.id, productId: p };
}

async function issueInvoice(orderId: string, issuedAt: string): Promise<string> {
  const id = await asUser(ADMIN, async (c) => (await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [orderId])).rows[0].id);
  await q(`update issued_documents set issued_at = $1 where id = $2`, [issuedAt, id]);
  return id;
}

async function issueCreditNote(orderId: string, productId: string, tag: string, total: number, issuedAt: string): Promise<string> {
  const [line] = await q<{ id: string }>(`select id from sales_order_lines where sales_order_id=$1 limit 1`, [orderId]);
  const [cn] = await q<{ id: string }>(
    `insert into credit_notes(code, sales_order_id, credit_date) values($1,$2,$3) returning id`,
    [`CN-${tag}`, orderId, issuedAt],
  );
  await q(
    `insert into credit_note_lines(credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price)
     values($1,$2,$3,1,'ml',$4)`,
    [cn.id, line.id, productId, total],
  );
  const id = await asUser(ADMIN, async (c) => (await c.query<{ id: string }>(`select issue_document('credit_note',null,$1) as id`, [cn.id])).rows[0].id);
  await q(`update issued_documents set issued_at = $1 where id = $2`, [issuedAt, id]);
  return id;
}

async function receipt(customerId: string, date: string, amount: number, allocations: { invoiceId: string; amount: number }[] = []) {
  return asUser(ADMIN, (c) =>
    c.query(`select apply_customer_receipt($1,$2,$3,$4,$5,$6::jsonb) as id`, [customerId, date, amount, 'bank', `ref-${date}`, JSON.stringify(allocations)]),
  );
}

async function directPayment(invoiceId: string, amount: number, date: string) {
  return asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1,$2,$3,$4,$5) as id`, [invoiceId, amount, date, 'bank', 'direct']));
}

interface Entry {
  entry_date: string;
  entry_type: string;
  reference: string | null;
  debit: string | null;
  credit: string | null;
  balance: string;
}
async function ledger(customerId: string, start: string, end: string): Promise<Entry[]> {
  return q<Entry>(`select * from customer_ledger($1,$2,$3)`, [customerId, start, end]);
}
const num = (v: string | null) => (v === null ? null : Number(v));

const JUL = ['2026-07-01', '2026-07-31'] as const;

describe('customer ledger (running account)', () => {
  it('opens with the prior balance and carries it down invoices, credit notes and receipts', async () => {
    const a = await makeOrder('la', 1000);
    await issueInvoice(a.orderId, '2026-06-15'); // before window
    await receipt(a.customerId, '2026-06-20', 400); // before window → opening = 1000 − 400 = 600

    const b = await orderForCustomer('lb', a.customerId, 500);
    await issueInvoice(b.orderId, '2026-07-05');
    await issueCreditNote(b.orderId, b.productId, 'lc', 100, '2026-07-10');
    await receipt(a.customerId, '2026-07-15', 200);

    const rows = await ledger(a.customerId, ...JUL);
    expect(rows).toHaveLength(4);

    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(600);

    expect(rows[1].entry_type).toBe('invoice');
    expect(num(rows[1].debit)).toBe(500);
    expect(num(rows[1].balance)).toBe(1100);

    expect(rows[2].entry_type).toBe('credit_note');
    expect(num(rows[2].credit)).toBe(100);
    expect(num(rows[2].balance)).toBe(1000);

    expect(rows[3].entry_type).toBe('receipt');
    expect(num(rows[3].credit)).toBe(200);
    expect(num(rows[3].balance)).toBe(800); // closing
  });

  it('shows a direct payment but does not double-count a receipt-tagged one', async () => {
    const a = await makeOrder('pa', 1000);
    const inv = await issueInvoice(a.orderId, '2026-07-02');
    await directPayment(inv, 300, '2026-07-05'); // receipt_id null → a payment line
    await receipt(a.customerId, '2026-07-08', 200, [{ invoiceId: inv, amount: 200 }]); // lump + tagged payment

    const rows = await ledger(a.customerId, ...JUL);
    // opening + invoice + payment + receipt — the tagged payment is folded into the receipt lump
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.entry_type === 'payment')).toHaveLength(1);
    expect(rows.filter((r) => r.entry_type === 'receipt')).toHaveLength(1);
    expect(num(rows[rows.length - 1].balance)).toBe(500); // 1000 − 300 − 200
  });

  it('excludes a voided invoice from the balance', async () => {
    const a = await makeOrder('va', 500);
    const inv = await issueInvoice(a.orderId, '2026-07-03');
    await q(`update issued_documents set voided_at = now() where id = $1`, [inv]);

    const rows = await ledger(a.customerId, ...JUL);
    expect(rows).toHaveLength(1); // just the opening row
    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(0);
  });

  it('folds pre-window activity into the opening balance and ignores post-window activity', async () => {
    const a = await makeOrder('fa', 100);
    await issueInvoice(a.orderId, '2026-05-01'); // before → opening 100

    const after = await orderForCustomer('fb', a.customerId, 200);
    await issueInvoice(after.orderId, '2026-09-01'); // after window → not shown at all

    const inside = await orderForCustomer('fc', a.customerId, 50);
    await issueInvoice(inside.orderId, '2026-07-10');

    const rows = await ledger(a.customerId, ...JUL);
    expect(rows).toHaveLength(2); // opening + the July invoice
    expect(num(rows[0].balance)).toBe(100);
    expect(rows[1].entry_type).toBe('invoice');
    expect(num(rows[1].balance)).toBe(150);
    // the September invoice appears nowhere in the window
    const [sept] = await q<{ document_number: string }>(`select document_number from issued_documents where sales_order_id=$1`, [after.orderId]);
    expect(rows.some((r) => r.reference === sept.document_number)).toBe(false);
  });

  it('gives an empty account a single opening row at nil', async () => {
    await seedRoles();
    const [cust] = await q<{ id: string }>(`insert into customers(code,name,tax_exempt) values('C-empty','C-empty',true) returning id`, []);
    const rows = await ledger(cust.id, ...JUL);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';
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
async function seedAdmin(): Promise<void> {
  await q(`insert into app_users(user_id, role) values($1,'admin') on conflict do nothing`, [ADMIN]);
}
async function createSupplier(tag: string): Promise<string> {
  await seedAdmin();
  const [s] = await q<{ id: string }>(`insert into suppliers(code,name,payment_terms_days) values($1,$1,30) returning id`, [`S-${tag}`]);
  return s.id;
}
async function makeBill(supplier: string, number: string, date: string, amount: number): Promise<string> {
  return asUser(ADMIN, async (c) => (await c.query<{ id: string }>(`select create_bill($1,$2,$3::date,$4,null,null) as id`, [supplier, number, date, amount])).rows[0].id);
}
async function payBill(bill: string, amount: number, date: string) {
  return asUser(ADMIN, (c) => c.query(`select record_bill_payment($1,$2,$3::date,$4,$5)`, [bill, amount, date, 'Bank transfer', null]));
}

interface Entry {
  entry_date: string;
  entry_type: string;
  reference: string | null;
  debit: string | null;
  credit: string | null;
  balance: string;
}
async function ledger(supplierId: string, start: string, end: string): Promise<Entry[]> {
  return q<Entry>(`select * from supplier_ledger($1,$2,$3)`, [supplierId, start, end]);
}
const num = (v: string | null) => (v === null ? null : Number(v));

const JUL = ['2026-07-01', '2026-07-31'] as const;

describe('supplier ledger (running account)', () => {
  it('opens with the prior balance and carries it down bills and payments', async () => {
    const s = await createSupplier('la');
    await makeBill(s, 'BILL-A', '2026-06-15', 1000); // before window
    const billA = (await q<{ id: string }>(`select id from bills where bill_number='BILL-A'`))[0].id;
    await payBill(billA, 400, '2026-06-20'); // before window → opening = 1000 − 400 = 600

    const billB = await makeBill(s, 'BILL-B', '2026-07-05', 500);
    await payBill(billB, 200, '2026-07-15');

    const rows = await ledger(s, ...JUL);
    expect(rows).toHaveLength(3);

    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(600);

    expect(rows[1].entry_type).toBe('bill');
    expect(num(rows[1].debit)).toBe(500);
    expect(num(rows[1].balance)).toBe(1100);

    expect(rows[2].entry_type).toBe('payment');
    expect(num(rows[2].credit)).toBe(200);
    expect(num(rows[2].balance)).toBe(900); // closing
  });

  it('excludes a voided bill from the balance', async () => {
    const s = await createSupplier('va');
    const bill = await makeBill(s, 'BILL-V', '2026-07-03', 500);
    await asUser(ADMIN, (c) => c.query(`select void_bill($1,'duplicate')`, [bill]));

    const rows = await ledger(s, ...JUL);
    expect(rows).toHaveLength(1); // just the opening row
    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(0);
  });

  it('folds pre-window bills into the opening balance and ignores post-window ones', async () => {
    const s = await createSupplier('fa');
    await makeBill(s, 'BILL-EARLY', '2026-05-01', 100); // before → opening 100
    await makeBill(s, 'BILL-LATE', '2026-09-01', 200); // after window → not shown
    await makeBill(s, 'BILL-IN', '2026-07-10', 50); // in window

    const rows = await ledger(s, ...JUL);
    expect(rows).toHaveLength(2); // opening + the July bill
    expect(num(rows[0].balance)).toBe(100);
    expect(rows[1].entry_type).toBe('bill');
    expect(num(rows[1].balance)).toBe(150);
    expect(rows.some((r) => r.reference === 'BILL-LATE')).toBe(false);
  });

  it('gives an empty account a single opening row at nil', async () => {
    const s = await createSupplier('empty');
    const rows = await ledger(s, ...JUL);
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_type).toBe('opening');
    expect(num(rows[0].balance)).toBe(0);
  });
});

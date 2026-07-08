import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const VIEWER = '22222222-2222-2222-2222-222222222222';
const AS_OF = '2026-07-01';

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

async function makeSupplier(tag: string, terms = 30): Promise<string> {
  await seedRoles();
  const [s] = await q<{ id: string }>(
    `insert into suppliers(code,name,payment_terms_days) values($1,$2,$3) returning id`,
    [`SUP-${tag}`, `Supplier ${tag}`, terms],
  );
  return s.id;
}

async function makeBill(
  supplierId: string,
  tag: string,
  amount = 500,
  billDate = '2026-06-01',
  dueDate: string | null = null,
): Promise<string> {
  return asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select create_bill($1,$2,$3::date,$4,$5::date,$6) as id`,
      [supplierId, `BILL-${tag}`, billDate, amount, dueDate, null],
    );
    return rows[0].id;
  });
}

async function pay(billId: string, amount: number, sub = ADMIN) {
  return asUser(sub, (c) =>
    c.query(`select record_bill_payment($1,$2,'2026-06-20','Bank transfer',null)`, [billId, amount]),
  );
}

/** Position a bill's due date so it is `daysOverdue` days past due as of AS_OF (negative = not yet due). */
async function dueIn(billId: string, daysOverdue: number): Promise<void> {
  await q(`update bills set due_date = ($1::date - $2::int) where id=$3`, [AS_OF, daysOverdue, billId]);
}

async function payablesById(supplierId: string | null = null): Promise<Record<string, any>> {
  const rows = await asUser(ADMIN, async (c) => (await c.query(`select * from bill_payables($1)`, [supplierId])).rows);
  return Object.fromEntries(rows.map((r: any) => [r.bill_id, r]));
}

async function agingById(asOf = AS_OF): Promise<Record<string, any>> {
  const rows = await asUser(ADMIN, async (c) => (await c.query(`select * from payables_aging($1)`, [asOf])).rows);
  return Object.fromEntries(rows.map((r: any) => [r.bill_id, r]));
}

describe('accounts payable', () => {
  it('creates a bill with a due date from the supplier terms and derives its open balance', async () => {
    const sup = await makeSupplier('A', 45);
    const bill = await makeBill(sup, 'A', 500, '2026-06-01');
    const p = await payablesById(sup);
    expect(Number(p[bill].amount)).toBe(500);
    expect(Number(p[bill].paid)).toBe(0);
    expect(Number(p[bill].open)).toBe(500);
    expect(p[bill].status).toBe('open');
    const [{ net }] = await q<{ net: number }>(`select (due_date - bill_date) as net from bills where id=$1`, [bill]);
    expect(Number(net)).toBe(45); // bill date + supplier terms
  });

  it('honours an explicit due date over the supplier terms', async () => {
    const sup = await makeSupplier('E', 30);
    const bill = await makeBill(sup, 'E', 100, '2026-06-01', '2026-06-10');
    const [{ due }] = await q<{ due: string }>(`select due_date::text as due from bills where id=$1`, [bill]);
    expect(due).toBe('2026-06-10');
  });

  it('settles a bill through payments and enforces the guards', async () => {
    const sup = await makeSupplier('P', 30);
    const bill = await makeBill(sup, 'P', 100);
    await pay(bill, 40);
    let p = await payablesById(sup);
    expect(Number(p[bill].paid)).toBe(40);
    expect(Number(p[bill].open)).toBe(60);
    expect(p[bill].status).toBe('partially_paid');

    await expect(pay(bill, 61)).rejects.toThrow(/exceeds the open balance/i); // over-payment
    await expect(pay(bill, 10, VIEWER)).rejects.toThrow(/administrator/i); // non-admin

    await pay(bill, 60); // settle fully
    p = await payablesById(sup);
    expect(Number(p[bill].open)).toBe(0);
    expect(p[bill].status).toBe('paid');

    await expect(pay(bill, 1)).rejects.toThrow(/exceeds the open balance/i); // nothing left to pay
  });

  it('reopens the balance when a payment is deleted', async () => {
    const sup = await makeSupplier('D', 30);
    const bill = await makeBill(sup, 'D', 100);
    await pay(bill, 100);
    expect((await payablesById(sup))[bill].status).toBe('paid');

    const [pmt] = await q<{ id: string }>(`select id from bill_payments where bill_id=$1`, [bill]);
    await asUser(ADMIN, (c) => c.query(`select delete_bill_payment($1)`, [pmt.id]));
    const p = await payablesById(sup);
    expect(Number(p[bill].open)).toBe(100);
    expect(p[bill].status).toBe('open');
  });

  it('voids an unpaid bill and refuses to void a paid one', async () => {
    const sup = await makeSupplier('V', 30);
    const unpaid = await makeBill(sup, 'V1', 100);
    await asUser(ADMIN, (c) => c.query(`select void_bill($1,'duplicate entry')`, [unpaid]));
    expect((await payablesById(sup))[unpaid].status).toBe('void');

    await expect(asUser(ADMIN, (c) => c.query(`select void_bill($1,'again')`, [unpaid]))).rejects.toThrow(
      /already voided/i,
    );

    const paid = await makeBill(sup, 'V2', 100);
    await pay(paid, 50);
    await expect(asUser(ADMIN, (c) => c.query(`select void_bill($1,'nope')`, [paid]))).rejects.toThrow(
      /recorded payments/i,
    );

    const other = await makeBill(sup, 'V3', 100);
    await expect(asUser(VIEWER, (c) => c.query(`select void_bill($1,'x')`, [other]))).rejects.toThrow(/administrator/i);
    await expect(asUser(ADMIN, (c) => c.query(`select void_bill($1,'')`, [other]))).rejects.toThrow(/reason/i);
  });

  it('buckets open bills by days past due and excludes paid and voided', async () => {
    const sup = await makeSupplier('G', 30);
    const notDue = await makeBill(sup, 'ND', 100);
    await dueIn(notDue, -5);
    const early = await makeBill(sup, 'EA', 100);
    await dueIn(early, 15);
    const mid = await makeBill(sup, 'MI', 100);
    await dueIn(mid, 45);
    const late = await makeBill(sup, 'LA', 100);
    await dueIn(late, 75);
    const stale = await makeBill(sup, 'ST', 100);
    await dueIn(stale, 120);
    const paidBill = await makeBill(sup, 'PD', 100);
    await dueIn(paidBill, 50);
    await pay(paidBill, 100);
    const voidBill = await makeBill(sup, 'VD', 100);
    await dueIn(voidBill, 50);
    await asUser(ADMIN, (c) => c.query(`select void_bill($1,'x')`, [voidBill]));

    const byId = await agingById();
    expect(byId[notDue].bucket).toBe('current');
    expect(byId[early].bucket).toBe('d1_30');
    expect(byId[mid].bucket).toBe('d31_60');
    expect(byId[late].bucket).toBe('d61_90');
    expect(byId[stale].bucket).toBe('d90_plus');
    expect(byId[paidBill]).toBeUndefined();
    expect(byId[voidBill]).toBeUndefined();
  });

  it('locks bills and bill_payments against direct client writes', async () => {
    const sup = await makeSupplier('W', 30);
    const bill = await makeBill(sup, 'W', 100);
    // reads allowed
    await asUser(VIEWER, (c) => c.query(`select * from bills`));
    await asUser(VIEWER, (c) => c.query(`select * from bill_payments`));
    // direct writes denied
    await expect(
      asUser(ADMIN, (c) =>
        c.query(`insert into bills(supplier_id,bill_number,amount) values($1,'X',10)`, [sup]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`insert into bill_payments(bill_id,amount) values($1,10)`, [bill])),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

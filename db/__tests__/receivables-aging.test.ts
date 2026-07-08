import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
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
  await q(`insert into app_users(user_id, role) values($1,'admin') on conflict do nothing`, [ADMIN]);
}

/** Create an order with one priced line for a customer on the given terms, and issue it. */
async function issuedInvoice(tag: string, terms = 30, unitPrice = 100, quantity = 1): Promise<string> {
  await seedRoles();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,payment_terms_days,tax_exempt) values($1,$2,$3,true) returning id`,
    [`C-${tag}`, `Cust ${tag}`, terms],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-06-01',$4::jsonb) as id`,
    [`SO-${tag}`, cust.id, wh, JSON.stringify([{ product_id: p, quantity, unit: 'ml', unit_price: unitPrice }])],
  );
  return asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id]);
    return rows[0].id;
  });
}

/** Position an invoice's due date so it is `daysOverdue` days past due as of AS_OF (negative = not yet due). */
async function dueIn(docId: string, daysOverdue: number): Promise<void> {
  await q(`update issued_documents set due_date = ($1::date - $2::int) where id=$3`, [AS_OF, daysOverdue, docId]);
}

async function agingById(asOf = AS_OF): Promise<Record<string, any>> {
  const rows = await asUser(ADMIN, async (c) => (await c.query(`select * from receivables_aging($1)`, [asOf])).rows);
  return Object.fromEntries(rows.map((r: any) => [r.issued_document_id, r]));
}

async function receivableById(docId: string): Promise<any> {
  const rows = await asUser(ADMIN, async (c) =>
    (await c.query(`select * from invoice_receivables() where issued_document_id=$1`, [docId])).rows,
  );
  return rows[0];
}

describe('due-date aging', () => {
  it('stamps the due date from the customer terms at issuance and flags overdue against today', async () => {
    const inv = await issuedInvoice('TERMS', 45); // Net 45
    const r = await receivableById(inv);
    const [{ net }] = await q<{ net: number }>(
      `select (due_date - current_date) as net from issued_documents where id=$1`,
      [inv],
    );
    expect(Number(net)).toBe(45); // issue date (today) + 45
    expect(r.overdue).toBe(false); // a future due date is not overdue

    await q(`update issued_documents set due_date = current_date - 5 where id=$1`, [inv]);
    expect((await receivableById(inv)).overdue).toBe(true);
    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 100.00, '2026-06-20', 'QRIS', null)`, [inv]));
    expect((await receivableById(inv)).overdue).toBe(false); // open 0 → not overdue
  });

  it('buckets each open invoice by how far past due it is', async () => {
    const notDue = await issuedInvoice('NOTDUE');
    await dueIn(notDue, -5); // due in the future
    const early = await issuedInvoice('EARLY');
    await dueIn(early, 15); // 1–30 past due
    const mid = await issuedInvoice('MID');
    await dueIn(mid, 45); // 31–60
    const late = await issuedInvoice('LATE');
    await dueIn(late, 75); // 61–90
    const stale = await issuedInvoice('STALE');
    await dueIn(stale, 120); // 90+

    const byId = await agingById();
    expect(Object.keys(byId)).toHaveLength(5);
    expect(byId[notDue].bucket).toBe('current');
    expect(byId[notDue].days_overdue).toBe(-5);
    expect(byId[early].bucket).toBe('d1_30');
    expect(byId[mid].bucket).toBe('d31_60');
    expect(byId[late].bucket).toBe('d61_90');
    expect(byId[stale].bucket).toBe('d90_plus');
  });

  it('places invoices at the bucket boundaries correctly', async () => {
    const cases: [number, string][] = [
      [-10, 'current'],
      [0, 'current'],
      [1, 'd1_30'],
      [30, 'd1_30'],
      [31, 'd31_60'],
      [60, 'd31_60'],
      [61, 'd61_90'],
      [90, 'd61_90'],
      [91, 'd90_plus'],
    ];
    const made: { docId: string; days: number; bucket: string }[] = [];
    for (const [days, bucket] of cases) {
      const docId = await issuedInvoice(`B${days + 100}`);
      await dueIn(docId, days);
      made.push({ docId, days, bucket });
    }
    const byId = await agingById();
    for (const m of made) {
      expect(byId[m.docId].days_overdue).toBe(m.days);
      expect(byId[m.docId].bucket).toBe(m.bucket);
    }
  });

  it('excludes paid and voided invoices; includes a partially-paid one at its open balance', async () => {
    const paid = await issuedInvoice('PAID');
    await dueIn(paid, 45);
    await asUser(ADMIN, (c) =>
      c.query(`select record_invoice_payment($1, 100.00, '2026-06-20', 'QRIS', null)`, [paid]),
    );

    const voided = await issuedInvoice('VOID');
    await dueIn(voided, 45);
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1,'issued in error')`, [voided]));

    const partial = await issuedInvoice('PART');
    await dueIn(partial, 75);
    await asUser(ADMIN, (c) =>
      c.query(`select record_invoice_payment($1, 30.00, '2026-06-20', 'QRIS', null)`, [partial]),
    );

    const byId = await agingById();
    expect(Object.keys(byId)).toHaveLength(1);
    expect(byId[paid]).toBeUndefined();
    expect(byId[voided]).toBeUndefined();
    expect(Number(byId[partial].total)).toBe(100);
    expect(Number(byId[partial].paid)).toBe(30);
    expect(Number(byId[partial].open)).toBe(70);
    expect(byId[partial].bucket).toBe('d61_90');
  });
});

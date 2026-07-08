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
async function seedAdmin(): Promise<void> {
  await q(`insert into app_users(user_id, role) values($1,'admin') on conflict do nothing`, [ADMIN]);
}

/** A customer with one issued invoice; returns the customer id, issued-document id, and its number. */
async function issuedInvoice(name: string): Promise<{ customerId: string; docId: string; number: string }> {
  await seedAdmin();
  const wh = await createWarehouse(`WH-${name}`);
  const p = await createProduct(`SKU-${name}`, 'ml');
  const [cust] = await q<{ id: string }>(`insert into customers(code,name,email) values($1,$2,'buyer@x.test') returning id`, [`C-${name}`, name]);
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
    [`SO-${name}`, cust.id, wh, JSON.stringify([{ product_id: p, quantity: 1, unit: 'ml', unit_price: 100 }])],
  );
  const docId = await asUser(ADMIN, async (c) => (await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id])).rows[0].id);
  const [d] = await q<{ document_number: string }>(`select document_number from issued_documents where id = $1`, [docId]);
  return { customerId: cust.id, docId, number: d.document_number };
}
const recordDocEmail = (docId: string, to: string, subject: string) =>
  asUser(ADMIN, (c) => c.query(`select record_document_email($1,$2,$3,'the message')`, [docId, to, subject]));
const recordStmtEmail = (customerId: string, start: string, end: string, to: string, subject: string) =>
  asUser(ADMIN, (c) => c.query(`select record_statement_email($1,$2,$3,$4,$5)`, [customerId, start, end, to, subject]));

interface Row {
  sent_at: string;
  kind: string;
  doc_kind: string | null;
  reference: string | null;
  party_name: string | null;
  recipient: string;
  subject: string;
}
const history = () => q<Row>(`select * from email_history()`);

describe('email history (unified send log)', () => {
  it('folds document and statement sends into one log with the right shape', async () => {
    const inv = await issuedInvoice('PT Wangi');
    await recordDocEmail(inv.docId, 'buyer@wangi.test', `Invoice ${inv.number}`);
    await recordStmtEmail(inv.customerId, '2026-07-01', '2026-07-31', 'ap@wangi.test', 'Statement');

    const rows = await history();
    expect(rows).toHaveLength(2);

    const doc = rows.find((r) => r.kind === 'document');
    expect(doc?.doc_kind).toBe('invoice');
    expect(doc?.reference).toBe(inv.number);
    expect(doc?.party_name).toBe('PT Wangi');
    expect(doc?.recipient).toBe('buyer@wangi.test');

    const stmt = rows.find((r) => r.kind === 'statement');
    expect(stmt?.doc_kind).toBeNull();
    expect(stmt?.reference).toBe('2026-07-01 – 2026-07-31');
    expect(stmt?.party_name).toBe('PT Wangi');
    expect(stmt?.recipient).toBe('ap@wangi.test');
  });

  it('orders most recent first across both trails', async () => {
    const inv = await issuedInvoice('PT Aroma');
    await recordDocEmail(inv.docId, 'a@aroma.test', `Invoice ${inv.number}`);
    await q(`update document_emails set sent_at = '2026-07-10 09:00+00' where recipient = 'a@aroma.test'`);
    await recordStmtEmail(inv.customerId, '2026-07-01', '2026-07-31', 'b@aroma.test', 'Statement');
    await q(`update statement_emails set sent_at = '2026-07-10 10:00+00' where recipient = 'b@aroma.test'`);

    const rows = await history();
    expect(rows[0].kind).toBe('statement'); // 10:00 is newer than 09:00
    expect(rows[1].kind).toBe('document');
  });

  it('returns nothing when no emails have been sent', async () => {
    await seedAdmin();
    const rows = await history();
    expect(rows).toHaveLength(0);
  });
});

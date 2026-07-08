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

/** An admin, one issued invoice — the fixture every test here starts from. */
async function issuedInvoice(): Promise<string> {
  await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
  const wh = await createWarehouse('WE');
  const p = await createProduct('PE', 'ml');
  const [cust] = await q(`insert into customers(code,name,email) values('CE','CE','buyer@example.test') returning id`);
  const [o] = await q(
    `select create_sales_order('SO-E',$1,$2,'2026-07-01',$3::jsonb) as id`,
    [cust.id, wh, JSON.stringify([{ product_id: p, quantity: 1, unit: 'ml', unit_price: 10 }])],
  );
  return asUser(ADMIN, async (c) => {
    const r = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id]);
    return r.rows[0].id;
  });
}

const record = (
  c: PoolClient,
  docId: string,
  recipient: string,
  subject = 'Invoice SO-E — TechnicoFlor',
  message = 'Please find attached.',
) => c.query<{ id: string }>(`select record_document_email($1,$2,$3,$4) as id`, [docId, recipient, subject, message]);

describe('document_emails (send record)', () => {
  it('records a send with the trimmed recipient and the real caller as sent_by', async () => {
    const docId = await issuedInvoice();
    const id = await asUser(ADMIN, async (c) => (await record(c, docId, '  buyer@example.test  ')).rows[0].id);

    const [row] = await q<{
      issued_document_id: string;
      recipient: string;
      subject: string;
      message: string;
      sent_by: string;
      sent_at: string;
    }>(`select issued_document_id, recipient, subject, message, sent_by, sent_at from document_emails where id=$1`, [id]);
    expect(row.issued_document_id).toBe(docId);
    expect(row.recipient).toBe('buyer@example.test'); // btrim'd
    expect(row.subject).toBe('Invoice SO-E — TechnicoFlor');
    expect(row.message).toBe('Please find attached.');
    expect(row.sent_by).toBe(ADMIN); // auth.uid() captured inside the DEFINER function
    expect(row.sent_at).toBeTruthy();
  });

  it('accumulates repeated sends as separate rows (append-only trail)', async () => {
    const docId = await issuedInvoice();
    await asUser(ADMIN, async (c) => {
      await record(c, docId, 'buyer@example.test');
      await record(c, docId, 'finance@example.test');
    });
    const rows = await q<{ recipient: string }>(
      `select recipient from document_emails where issued_document_id=$1 order by sent_at, recipient`,
      [docId],
    );
    expect(rows.map((r) => r.recipient)).toEqual(['buyer@example.test', 'finance@example.test']);
  });

  it('refuses a non-admin caller and records nothing', async () => {
    const docId = await issuedInvoice();
    await expect(asUser(VIEWER, (c) => record(c, docId, 'buyer@example.test'))).rejects.toThrow(/administrator/i);
    const [{ n }] = await q<{ n: string }>(`select count(*) n from document_emails`);
    expect(Number(n)).toBe(0);
  });

  it('rejects a blank recipient and a missing issued document', async () => {
    const docId = await issuedInvoice();
    await expect(asUser(ADMIN, (c) => record(c, docId, '   '))).rejects.toThrow(/recipient is required/i);
    await expect(
      asUser(ADMIN, (c) => record(c, '00000000-0000-0000-0000-000000000000', 'buyer@example.test')),
    ).rejects.toThrow(/not found/i);
  });

  it('denies a direct table write even to an admin — the DEFINER function is the only door', async () => {
    const docId = await issuedInvoice();
    await expect(
      asUser(ADMIN, (c) =>
        c.query(`insert into document_emails(issued_document_id, recipient, subject, message) values($1,'x@y.z','s','m')`, [
          docId,
        ]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

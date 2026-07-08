import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';
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

/** An admin and one customer — the fixture every test here starts from. */
async function customer(): Promise<string> {
  await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
  const [c] = await q<{ id: string }>(
    `insert into customers(code,name,email) values('CE','CE','buyer@example.test') returning id`,
  );
  return c.id;
}

const record = (
  c: PoolClient,
  customerId: string,
  recipient: string,
  start = '2026-07-01',
  end = '2026-07-31',
  subject = 'Statement of Account — TechnicoFlor',
) => c.query<{ id: string }>(`select record_statement_email($1,$2,$3,$4,$5) as id`, [customerId, start, end, recipient, subject]);

describe('statement_emails (send record)', () => {
  it('records a send with the period, trimmed recipient and the real caller as sent_by', async () => {
    const cust = await customer();
    const id = await asUser(ADMIN, async (c) => (await record(c, cust, '  buyer@example.test  ')).rows[0].id);

    const [row] = await q<{
      customer_id: string;
      recipient: string;
      subject: string;
      sent_by: string;
      sent_at: string;
    }>(`select customer_id, recipient, subject, sent_by, sent_at from statement_emails where id=$1`, [id]);
    expect(row.customer_id).toBe(cust);
    expect(row.recipient).toBe('buyer@example.test'); // btrim'd
    expect(row.subject).toBe('Statement of Account — TechnicoFlor');
    expect(row.sent_by).toBe(ADMIN); // auth.uid() captured inside the DEFINER function
    expect(row.sent_at).toBeTruthy();
    // period stored correctly (compared in the DB to sidestep driver date typing)
    const [match] = await q<{ ok: number }>(
      `select 1 ok from statement_emails where id=$1 and period_start='2026-07-01' and period_end='2026-07-31'`,
      [id],
    );
    expect(match?.ok).toBe(1);
  });

  it('accumulates repeated sends as separate rows (append-only trail)', async () => {
    const cust = await customer();
    await asUser(ADMIN, async (c) => {
      await record(c, cust, 'buyer@example.test');
      await record(c, cust, 'finance@example.test');
    });
    const rows = await q<{ recipient: string }>(
      `select recipient from statement_emails where customer_id=$1 order by sent_at, recipient`,
      [cust],
    );
    expect(rows.map((r) => r.recipient)).toEqual(['buyer@example.test', 'finance@example.test']);
  });

  it('refuses a non-admin caller and records nothing', async () => {
    const cust = await customer();
    await expect(asUser(VIEWER, (c) => record(c, cust, 'buyer@example.test'))).rejects.toThrow(/administrator/i);
    const [{ n }] = await q<{ n: string }>(`select count(*) n from statement_emails`);
    expect(Number(n)).toBe(0);
  });

  it('rejects a blank recipient and an unknown customer', async () => {
    const cust = await customer();
    await expect(asUser(ADMIN, (c) => record(c, cust, '   '))).rejects.toThrow(/recipient is required/i);
    await expect(
      asUser(ADMIN, (c) => record(c, '00000000-0000-0000-0000-000000000000', 'buyer@example.test')),
    ).rejects.toThrow(/not found/i);
  });

  it('denies a direct table write even to an admin — the DEFINER function is the only door', async () => {
    const cust = await customer();
    await expect(
      asUser(ADMIN, (c) =>
        c.query(
          `insert into statement_emails(customer_id, period_start, period_end, recipient, subject) values($1,'2026-07-01','2026-07-31','x@y.z','s')`,
          [cust],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

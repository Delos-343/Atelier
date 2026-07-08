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

/** Admin + one order with a priced line; returns the order id. */
async function fixtures(): Promise<string> {
  await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
  const wh = await createWarehouse('WS');
  const p = await createProduct('PSQ', 'ml');
  const [cust] = await q(`insert into customers(code,name) values('CS','CS') returning id`);
  const [o] = await q(
    `select create_sales_order('SO-SEQ',$1,$2,'2026-07-01',$3::jsonb) as id`,
    [cust.id, wh, JSON.stringify([{ product_id: p, quantity: 1, unit: 'ml', unit_price: 10 }])],
  );
  return o.id;
}

const YEAR = new Date().getFullYear();

describe('document sequences', () => {
  it('assigns each kind its own year-scoped series, self-contained in the snapshot', async () => {
    const oid = await fixtures();
    const [line] = await q<{ id: string }>(`select id from sales_order_lines where sales_order_id=$1`, [oid]);
    const [cn] = await q<{ id: string }>(
      `insert into credit_notes(code, sales_order_id, credit_date) values('CN-MANUAL',$1,'2026-07-02') returning id`,
      [oid],
    );
    await q(
      `insert into credit_note_lines(credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price)
       select $1, $2, product_id, 1, 'ml', 10 from sales_order_lines where id=$2`,
      [cn.id, line.id],
    );

    await asUser(ADMIN, async (c) => {
      await c.query(`select issue_document('invoice',$1,null)`, [oid]);
      await c.query(`select issue_document('invoice',$1,null)`, [oid]);
      await c.query(`select issue_document('packing_slip',$1,null)`, [oid]);
      await c.query(`select issue_document('credit_note',null,$1)`, [cn.id]);
    });

    const rows = await q<{ kind: string; document_number: string; snapshot: any }>(
      `select kind, document_number, snapshot from issued_documents order by issued_at, document_number`,
    );
    expect(rows.map((r) => r.document_number)).toEqual([
      `INV-${YEAR}-00001`,
      `INV-${YEAR}-00002`, // same kind advances
      `PS-${YEAR}-00001`, // other kinds start their own series
      `CN-${YEAR}-00001`,
    ]);
    for (const r of rows) expect(r.snapshot.number).toBe(r.document_number);
    // the identifiers the series numbers replaced are preserved on the snapshot
    expect(rows[0].snapshot.orderCode).toBe('SO-SEQ');
    expect(rows[2].snapshot.orderCode).toBe('SO-SEQ');
    expect(rows[3].snapshot.sourceCode).toBe('CN-MANUAL');
    expect(rows[3].snapshot.orderCode).toBe('SO-SEQ');
  });

  it('is gapless: a rolled-back issuance returns its number to the series', async () => {
    const oid = await fixtures();
    const rolledBack = await asUser(ADMIN, async (c) => {
      await c.query('begin');
      await c.query(`select issue_document('invoice',$1,null)`, [oid]);
      const { rows } = await c.query<{ n: string }>(`select document_number n from issued_documents limit 1`);
      await c.query('rollback');
      return rows[0].n;
    });
    expect(rolledBack).toBe(`INV-${YEAR}-00001`);

    const committed = await asUser(ADMIN, async (c) => {
      const { rows } = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [oid]);
      return rows[0].id;
    });
    const [{ document_number }] = await q<{ document_number: string }>(
      `select document_number from issued_documents where id=$1`,
      [committed],
    );
    expect(document_number).toBe(`INV-${YEAR}-00001`); // the rolled-back number, reused
  });

  it('serializes concurrent issuances into distinct, consecutive numbers', async () => {
    const oid = await fixtures();
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () =>
        asUser(ADMIN, (c) => c.query(`select issue_document('invoice',$1,null)`, [oid])),
      ),
    );
    const rows = await q<{ document_number: string }>(
      `select document_number from issued_documents order by document_number`,
    );
    const expected = Array.from({ length: N }, (_, i) => `INV-${YEAR}-${String(i + 1).padStart(5, '0')}`);
    expect(rows.map((r) => r.document_number)).toEqual(expected); // no duplicates, no gaps
  });

  it('scopes the series by year and widens rather than truncates past 99,999', async () => {
    // next_document_number is owner-only; the test pool connects as the owner.
    const [a] = await q<{ n: string }>(`select next_document_number('invoice', '2030-06-01') as n`);
    const [b] = await q<{ n: string }>(`select next_document_number('invoice', '2030-12-31') as n`);
    const [c] = await q<{ n: string }>(`select next_document_number('invoice', '2031-01-01') as n`);
    expect(a.n).toBe('INV-2030-00001');
    expect(b.n).toBe('INV-2030-00002'); // same year continues
    expect(c.n).toBe('INV-2031-00001'); // new year restarts

    await q(`update document_sequences set next_value = 100000 where kind='invoice' and year=2030`);
    const [wide] = await q<{ n: string }>(`select next_document_number('invoice', '2030-06-02') as n`);
    expect(wide.n).toBe('INV-2030-100000'); // 6 digits, not a truncated 5

    await expect(q(`select next_document_number('receipt')`)).rejects.toThrow(/unknown document kind/i);
  });

  it('locks the counter away from clients entirely (no grant, RLS, no policy)', async () => {
    await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
    await expect(
      asUser(ADMIN, (c) => c.query(`select * from document_sequences`)),
    ).rejects.toThrow(/permission denied/i); // even reads — internal machinery
    await expect(
      asUser(ADMIN, (c) => c.query(`insert into document_sequences(kind, year, next_value) values('invoice', 2026, 99)`)),
    ).rejects.toThrow(/permission denied|row-level security/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select next_document_number('invoice')`)),
    ).rejects.toThrow(/permission denied/i); // can't burn numbers around the issuer
  });
});

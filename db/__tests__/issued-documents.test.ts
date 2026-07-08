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

async function customer(code: string): Promise<string> {
  const [r] = await q(`insert into customers(code,name,tax_exempt) values($1,$1,true) returning id`, [code]);
  return r.id;
}

async function order(code: string, cust: string, wh: string, lines: unknown[]): Promise<string> {
  const [r] = await q(`select create_sales_order($1,$2,$3,'2026-04-04',$4::jsonb) as id`, [
    code,
    cust,
    wh,
    JSON.stringify(lines),
  ]);
  return r.id;
}

const issue = (c: PoolClient, kind: string, orderId: string | null, cnId: string | null = null) =>
  c.query<{ id: string }>(`select issue_document($1,$2,$3) as id`, [kind, orderId, cnId]);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('issued-document archive', () => {
  it('freezes an invoice snapshot that does not drift when the order later changes', async () => {
    await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
    const wh = await createWarehouse('WI');
    const p = await createProduct('PI', 'ml');
    const cust = await customer('CI');
    const oid = await order('SO-I', cust, wh, [{ product_id: p, quantity: 2, unit: 'ml', unit_price: 50 }]);

    const id = await asUser(ADMIN, async (c) => (await issue(c, 'invoice', oid)).rows[0].id);

    const [row] = await q<{
      kind: string;
      sales_order_id: string;
      credit_note_id: string | null;
      document_number: string;
      snapshot: any;
      issued_by: string;
    }>(
      `select kind, sales_order_id, credit_note_id, document_number, snapshot, issued_by
         from issued_documents where id=$1`,
      [id],
    );
    expect(row.kind).toBe('invoice');
    expect(row.document_number).toMatch(/^INV-\d{4}-00001$/); // first in the series
    expect(row.snapshot.number).toBe(row.document_number); // snapshot is self-contained
    expect(row.snapshot.orderCode).toBe('SO-I'); // the code the series number replaced
    expect(row.credit_note_id).toBeNull();
    expect(row.issued_by).toBe(ADMIN);
    expect(Number(row.snapshot.total)).toBeCloseTo(100, 6);

    // Mutate the order after issuance; the frozen snapshot must not move.
    await q(`update sales_order_lines set unit_price=999 where sales_order_id=$1`, [oid]);
    const [after] = await q<{ snapshot: any }>(`select snapshot from issued_documents where id=$1`, [id]);
    expect(Number(after.snapshot.total)).toBeCloseTo(100, 6);
    const [{ live }] = await q<{ live: string }>(
      `select (invoice_document($1)->>'total')::numeric as live`,
      [oid],
    );
    expect(Number(live)).toBeCloseTo(1998, 6); // live rebuild reflects the change
  });

  it('refuses issuance for a non-admin, recording nothing', async () => {
    const wh = await createWarehouse('WN');
    const p = await createProduct('PN', 'ml');
    const cust = await customer('CN');
    const oid = await order('SO-N', cust, wh, [{ product_id: p, quantity: 1, unit: 'ml', unit_price: 5 }]);
    await expect(asUser(VIEWER, (c) => issue(c, 'invoice', oid))).rejects.toThrow(/administrator/i);
    const [{ n }] = await q<{ n: string }>(
      `select count(*) n from issued_documents where sales_order_id=$1`,
      [oid],
    );
    expect(Number(n)).toBe(0);
  });

  it('issues a credit note carrying its credit_note_id and source order', async () => {
    await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
    const wh = await createWarehouse('WC');
    const p = await createProduct('PC', 'ml');
    const cust = await customer('CC');
    const oid = await order('SO-C', cust, wh, [{ product_id: p, quantity: 5, unit: 'ml', unit_price: 8 }]);
    const [line] = await q<{ id: string }>(`select id from sales_order_lines where sales_order_id=$1`, [oid]);
    const [cn] = await q<{ id: string }>(
      `insert into credit_notes(code, sales_order_id, credit_date) values('CN-1',$1,'2026-05-05') returning id`,
      [oid],
    );
    await q(
      `insert into credit_note_lines(credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price)
       values($1,$2,$3,2,'ml',8)`,
      [cn.id, line.id, p],
    );

    const id = await asUser(ADMIN, async (c) => (await issue(c, 'credit_note', null, cn.id)).rows[0].id);
    const [row] = await q<{
      kind: string;
      sales_order_id: string;
      credit_note_id: string;
      document_number: string;
      snapshot: any;
    }>(
      `select kind, sales_order_id, credit_note_id, document_number, snapshot
         from issued_documents where id=$1`,
      [id],
    );
    expect(row.kind).toBe('credit_note');
    expect(row.credit_note_id).toBe(cn.id);
    expect(row.sales_order_id).toBe(oid);
    expect(row.document_number).toMatch(/^CN-\d{4}-00001$/);
    expect(row.snapshot.number).toBe(row.document_number);
    expect(row.snapshot.sourceCode).toBe('CN-1'); // the manual code the series number replaced
    expect(row.snapshot.orderCode).toBe('SO-C');
    expect(Number(row.snapshot.total)).toBeCloseTo(16, 6);
  });

  it('lists issued documents for an order and rejects a missing source', async () => {
    await q(`insert into app_users(user_id,role) values($1,'admin')`, [ADMIN]);
    const wh = await createWarehouse('WL');
    const p = await createProduct('PL', 'ml');
    const cust = await customer('CL');
    const oid = await order('SO-L', cust, wh, [{ product_id: p, quantity: 1, unit: 'ml', unit_price: 5 }]);
    await asUser(ADMIN, async (c) => {
      await issue(c, 'invoice', oid);
      await issue(c, 'packing_slip', oid);
    });
    const rows = await q<{ kind: string }>(
      `select kind from issued_documents where sales_order_id=$1 order by issued_at desc`,
      [oid],
    );
    expect(rows).toHaveLength(2);

    await expect(
      asUser(ADMIN, (c) => issue(c, 'invoice', '00000000-0000-0000-0000-000000000000')),
    ).rejects.toThrow(/not found/i);
  });
});

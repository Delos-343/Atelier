import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

async function customer(code: string, extra?: { email?: string; address?: string }): Promise<string> {
  const [r] = await q(
    `insert into customers(code,name,email,address,tax_exempt) values($1,$1,$2,$3,true) returning id`,
    [code, extra?.email ?? null, extra?.address ?? null],
  );
  return r.id;
}

async function order(
  code: string,
  cust: string,
  wh: string,
  lines: unknown[],
): Promise<string> {
  const [r] = await q(`select create_sales_order($1,$2,$3,'2026-03-03',$4::jsonb) as id`, [
    code,
    cust,
    wh,
    JSON.stringify(lines),
  ]);
  return r.id;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const invoice = async (oid: string): Promise<any> =>
  (await q<{ d: any }>(`select invoice_document($1) as d`, [oid]))[0].d;
const packing = async (oid: string): Promise<any> =>
  (await q<{ d: any }>(`select packing_slip_document($1) as d`, [oid]))[0].d;
const creditNote = async (id: string): Promise<any> =>
  (await q<{ d: any }>(`select credit_note_document($1) as d`, [id]))[0].d;

describe('printable documents', () => {
  it('invoice: header, customer, priced lines sorted by sku, and total', async () => {
    const wh = await createWarehouse('WHI');
    const p1 = await createProduct('INV-A', 'ml');
    const p2 = await createProduct('INV-B', 'ml');
    const cust = await customer('ACME', { email: 'buyer@acme.test', address: '12 Rose St' });
    const oid = await order('SO-INV', cust, wh, [
      { product_id: p2, quantity: 2, unit: 'ml', unit_price: 10 },
      { product_id: p1, quantity: 3, unit: 'ml', unit_price: 25 },
    ]);

    const d = await invoice(oid);
    expect(d.kind).toBe('invoice');
    expect(d.number).toBe('SO-INV');
    expect(d.customer.name).toBe('ACME');
    expect(d.customer.email).toBe('buyer@acme.test');
    expect(d.warehouse.code).toBe('WHI');
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].sku).toBe('INV-A'); // ordered by sku
    expect(Number(d.lines[0].lineTotal)).toBeCloseTo(75, 6);
    expect(Number(d.lines[1].lineTotal)).toBeCloseTo(20, 6);
    expect(Number(d.total)).toBeCloseTo(95, 6);
  });

  it('packing slip: ordered vs shipped, and carries no prices', async () => {
    const wh = await createWarehouse('WHP');
    const p1 = await createProduct('PS-A', 'ml');
    const cust = await customer('PCUST');
    const oid = await order('SO-PS', cust, wh, [{ product_id: p1, quantity: 10, unit: 'ml', unit_price: 5 }]);
    await q(`update sales_order_lines set shipped_quantity=4 where sales_order_id=$1`, [oid]);

    const d = await packing(oid);
    expect(d.kind).toBe('packing-slip');
    expect(Number(d.lines[0].ordered)).toBeCloseTo(10, 6);
    expect(Number(d.lines[0].shipped)).toBeCloseTo(4, 6);
    expect(d.lines[0]).not.toHaveProperty('unitPrice');
    expect(d).not.toHaveProperty('total');
  });

  it('credit note: refunded lines, source order code, and total', async () => {
    const wh = await createWarehouse('WHC');
    const p1 = await createProduct('CN-A', 'ml');
    const cust = await customer('CNCUST');
    const oid = await order('SO-CN', cust, wh, [{ product_id: p1, quantity: 5, unit: 'ml', unit_price: 8 }]);
    const [line] = await q<{ id: string }>(`select id from sales_order_lines where sales_order_id=$1`, [oid]);
    const [cn] = await q<{ id: string }>(
      `insert into credit_notes(code, sales_order_id, credit_date) values('CN-1',$1,'2026-03-04') returning id`,
      [oid],
    );
    await q(
      `insert into credit_note_lines(credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price, cogs_reversed)
       values($1,$2,$3,2,'ml',8,0)`,
      [cn.id, line.id, p1],
    );

    const d = await creditNote(cn.id);
    expect(d.kind).toBe('credit-note');
    expect(d.number).toBe('CN-1');
    expect(d.orderCode).toBe('SO-CN');
    expect(d.customer.name).toBe('CNCUST');
    expect(d.lines).toHaveLength(1);
    expect(Number(d.lines[0].lineTotal)).toBeCloseTo(16, 6);
    expect(Number(d.total)).toBeCloseTo(16, 6);
  });

  it('returns null for a missing id (surfaced as a 404 by the API)', async () => {
    expect(await invoice('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await creditNote('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

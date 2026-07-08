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
async function setPpnRate(rate: number): Promise<void> {
  await q(`update tax_settings set ppn_rate = $1 where id = true`, [rate]);
}

/** Issue a taxed invoice for a fresh customer; returns the issued document id. */
async function issueInvoice(
  tag: string,
  opts: { unitPrice?: number; quantity?: number; exempt?: boolean; issuedAt?: string } = {},
): Promise<string> {
  await seedAdmin();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,payment_terms_days,discount_pct,tax_exempt)
     values($1,$1,30,0,$2) returning id`,
    [`C-${tag}`, opts.exempt ?? false],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-06-01',$4::jsonb) as id`,
    [`SO-${tag}`, cust.id, wh, JSON.stringify([{ product_id: p, quantity: opts.quantity ?? 1, unit: 'ml', unit_price: opts.unitPrice ?? 100 }])],
  );
  const docId = await asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id]);
    return rows[0].id;
  });
  if (opts.issuedAt) {
    await q(`update issued_documents set issued_at = $1 where id = $2`, [opts.issuedAt, docId]);
  }
  return docId;
}

async function createSupplier(tag: string): Promise<string> {
  await seedAdmin();
  const [s] = await q<{ id: string }>(
    `insert into suppliers(code,name,payment_terms_days) values($1,$1,30) returning id`,
    [`S-${tag}`],
  );
  return s.id;
}

async function createBill(supplier: string, number: string, date: string, amount: number, tax: number) {
  return asUser(ADMIN, (c) =>
    c.query(`select create_bill($1,$2,$3,$4,null,null,$5) as id`, [supplier, number, date, amount, tax]),
  );
}

async function taxReport(start: string, end: string) {
  const [row] = await q<any>(`select * from tax_report($1,$2)`, [start, end]);
  return row;
}

const JUN = ['2026-06-01', '2026-06-30'] as const;

describe('tax report', () => {
  it('sums output tax from invoices and input tax from bills, netting to payable', async () => {
    await setPpnRate(11);
    // sales: 1000 taxable → 110 PPN out, 1110 total
    await issueInvoice('a', { unitPrice: 1000, issuedAt: '2026-06-15' });
    // purchase: 555 with 55 PPN in → 500 net
    const sup = await createSupplier('a');
    await createBill(sup, 'SUP-1', '2026-06-10', 555, 55);

    const r = await taxReport(...JUN);
    expect(Number(r.output_tax)).toBe(110);
    expect(Number(r.taxable_sales)).toBe(1000);
    expect(Number(r.invoice_count)).toBe(1);
    expect(Number(r.input_tax)).toBe(55);
    expect(Number(r.taxable_purchases)).toBe(500);
    expect(Number(r.bill_count)).toBe(1);
    expect(Number(r.net_payable)).toBe(55); // 110 − 55 owed to the office
  });

  it('nets to a credit when input tax exceeds output tax', async () => {
    await setPpnRate(11);
    await issueInvoice('b', { unitPrice: 1000, issuedAt: '2026-06-15' }); // 110 out
    const sup = await createSupplier('b');
    await createBill(sup, 'SUP-B', '2026-06-10', 2200, 200); // 200 in

    const r = await taxReport(...JUN);
    expect(Number(r.net_payable)).toBe(-90); // a credit to carry
  });

  it('counts only invoices and bills dated within the period', async () => {
    await setPpnRate(11);
    await issueInvoice('in', { unitPrice: 1000, issuedAt: '2026-06-15' }); // in June
    await issueInvoice('out', { unitPrice: 1000, issuedAt: '2026-07-15' }); // out
    const sup = await createSupplier('c');
    await createBill(sup, 'B-IN', '2026-06-20', 555, 55); // in
    await createBill(sup, 'B-OUT', '2026-07-20', 555, 55); // out

    const r = await taxReport(...JUN);
    expect(Number(r.output_tax)).toBe(110);
    expect(Number(r.invoice_count)).toBe(1);
    expect(Number(r.input_tax)).toBe(55);
    expect(Number(r.bill_count)).toBe(1);
  });

  it('excludes voided invoices and voided bills', async () => {
    await setPpnRate(11);
    await issueInvoice('live', { unitPrice: 1000, issuedAt: '2026-06-15' });
    const voided = await issueInvoice('void', { unitPrice: 1000, issuedAt: '2026-06-15' });
    await q(`update issued_documents set voided_at = now() where id = $1`, [voided]);

    const sup = await createSupplier('d');
    await createBill(sup, 'B-LIVE', '2026-06-10', 555, 55);
    const vb = await createBill(sup, 'B-VOID', '2026-06-10', 555, 55);
    const vbId = (vb as any).rows[0].id;
    await q(`update bills set voided_at = now() where id = $1`, [vbId]);

    const r = await taxReport(...JUN);
    expect(Number(r.output_tax)).toBe(110); // only the live invoice
    expect(Number(r.invoice_count)).toBe(1);
    expect(Number(r.input_tax)).toBe(55); // only the live bill
    expect(Number(r.bill_count)).toBe(1);
  });

  it('shows a tax-exempt sale in the base at zero tax, and ignores pre-tax invoices', async () => {
    await setPpnRate(11);
    await issueInvoice('taxed', { unitPrice: 1000, issuedAt: '2026-06-15' }); // 110 tax, 1000 base
    await issueInvoice('exempt', { unitPrice: 500, exempt: true, issuedAt: '2026-06-15' }); // 0 tax, 500 base

    const r = await taxReport(...JUN);
    expect(Number(r.output_tax)).toBe(110); // exempt adds no tax
    expect(Number(r.taxable_sales)).toBe(1500); // but its discounted value is in the base
    expect(Number(r.invoice_count)).toBe(2);
  });

  it('rejects a bill whose tax exceeds its amount', async () => {
    const sup = await createSupplier('e');
    await expect(createBill(sup, 'BAD', '2026-06-10', 100, 150)).rejects.toThrow(/tax amount cannot exceed/i);
  });
});

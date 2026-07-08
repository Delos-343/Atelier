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
  const [s] = await q<{ id: string }>(`insert into suppliers(code,name,payment_terms_days) values($1,$1,30) returning id`, [`S-${tag}`]);
  return s.id;
}
async function createBill(supplier: string, number: string, date: string, amount: number, tax: number) {
  return asUser(ADMIN, (c) => c.query(`select create_bill($1,$2,$3,$4,null,null,$5) as id`, [supplier, number, date, amount, tax]));
}

interface Line {
  side: string;
  document_number: string;
  doc_date: string;
  party_code: string;
  party_name: string;
  party_tax_id: string | null;
  taxable_base: string;
  tax_amount: string;
}
async function lines(start: string, end: string): Promise<Line[]> {
  return q<Line>(`select * from tax_report_lines($1,$2)`, [start, end]);
}
async function taxReport(start: string, end: string) {
  const [row] = await q<Record<string, string>>(`select * from tax_report($1,$2)`, [start, end]);
  return row;
}
const num = (v: string) => Number(v);
const sum = (xs: string[]) => xs.reduce((a, b) => a + Number(b), 0);

const JUN = ['2026-06-01', '2026-06-30'] as const;

describe('tax report lines (faktur list)', () => {
  it('lists one output line per taxed invoice and reconciles to the summary', async () => {
    await setPpnRate(10);
    await issueInvoice('la', { unitPrice: 100, issuedAt: '2026-06-05' }); // base 100, tax 10
    await issueInvoice('lb', { unitPrice: 200, issuedAt: '2026-06-10' }); // base 200, tax 20

    const out = (await lines(...JUN)).filter((l) => l.side === 'output');
    expect(out).toHaveLength(2);
    const byNum = Object.fromEntries(out.map((l) => [l.party_code, l]));
    expect(num(byNum['C-la'].taxable_base)).toBe(100);
    expect(num(byNum['C-la'].tax_amount)).toBe(10);
    expect(num(byNum['C-lb'].tax_amount)).toBe(20);

    const rep = await taxReport(...JUN);
    expect(sum(out.map((l) => l.tax_amount))).toBe(num(rep.output_tax)); // 30
    expect(sum(out.map((l) => l.taxable_base))).toBe(num(rep.taxable_sales)); // 300
    expect(out.length).toBe(num(rep.invoice_count));
  });

  it('lists one input line per bill and reconciles to the summary', async () => {
    const sup = await createSupplier('lc');
    await createBill(sup, 'BILL-1', '2026-06-07', 111, 11); // base 100, tax 11
    await createBill(sup, 'BILL-2', '2026-06-12', 55.5, 5.5); // base 50, tax 5.50

    const inp = (await lines(...JUN)).filter((l) => l.side === 'input');
    expect(inp).toHaveLength(2);
    const byNum = Object.fromEntries(inp.map((l) => [l.document_number, l]));
    expect(num(byNum['BILL-1'].taxable_base)).toBe(100);
    expect(num(byNum['BILL-1'].tax_amount)).toBe(11);
    expect(num(byNum['BILL-2'].taxable_base)).toBe(50);
    expect(byNum['BILL-2'].party_code).toBe('S-lc');

    const rep = await taxReport(...JUN);
    expect(sum(inp.map((l) => l.tax_amount))).toBe(num(rep.input_tax)); // 16.50
    expect(sum(inp.map((l) => l.taxable_base))).toBe(num(rep.taxable_purchases)); // 150
    expect(inp.length).toBe(num(rep.bill_count));
  });

  it('shows an exempt sale as a zero-PPN line and excludes a voided invoice', async () => {
    await setPpnRate(10);
    await issueInvoice('ex', { unitPrice: 100, exempt: true, issuedAt: '2026-06-05' }); // base 100, tax 0
    const voided = await issueInvoice('vo', { unitPrice: 100, issuedAt: '2026-06-06' });
    await q(`update issued_documents set voided_at = now() where id = $1`, [voided]);

    const out = (await lines(...JUN)).filter((l) => l.side === 'output');
    expect(out).toHaveLength(1);
    expect(out[0].party_code).toBe('C-ex');
    expect(num(out[0].tax_amount)).toBe(0);
    expect(num(out[0].taxable_base)).toBe(100);
  });

  it('includes only in-window documents and decomposes the report exactly', async () => {
    await setPpnRate(10);
    await issueInvoice('in', { unitPrice: 100, issuedAt: '2026-06-15' }); // in
    await issueInvoice('out', { unitPrice: 999, issuedAt: '2026-05-15' }); // before window
    await createBill(await createSupplier('bin'), 'B-IN', '2026-06-20', 110, 10); // in
    await createBill(await createSupplier('bout'), 'B-OUT', '2026-07-20', 220, 20); // after window

    const all = await lines(...JUN);
    const nums = all.map((l) => l.document_number);
    expect(nums).not.toContain('B-OUT');
    expect(all.filter((l) => l.side === 'output')).toHaveLength(1); // 'in' only, not 'out'
    expect(all.filter((l) => l.side === 'input')).toHaveLength(1); // B-IN only

    const rep = await taxReport(...JUN);
    const out = all.filter((l) => l.side === 'output');
    const inp = all.filter((l) => l.side === 'input');
    expect(sum(out.map((l) => l.tax_amount))).toBe(num(rep.output_tax));
    expect(sum(inp.map((l) => l.tax_amount))).toBe(num(rep.input_tax));
  });

  it('carries each party NPWP onto the faktur line, and leaves it null when not on file', async () => {
    await setPpnRate(10);
    await issueInvoice('np', { unitPrice: 100, issuedAt: '2026-06-05' });
    await q(`update customers set tax_id = '01.234.567.8-000.000' where code = 'C-np'`);
    await issueInvoice('noid', { unitPrice: 100, issuedAt: '2026-06-06' }); // no tax_id set
    const sup = await createSupplier('nps');
    await q(`update suppliers set tax_id = '09.876.543.2-000.000' where id = $1`, [sup]);
    await createBill(sup, 'B-NP', '2026-06-07', 110, 10);

    const all = await lines(...JUN);
    const out = all.find((l) => l.side === 'output' && l.party_code === 'C-np');
    const outNoId = all.find((l) => l.side === 'output' && l.party_code === 'C-noid');
    const inp = all.find((l) => l.side === 'input' && l.document_number === 'B-NP');
    expect(out?.party_tax_id).toBe('01.234.567.8-000.000');
    expect(inp?.party_tax_id).toBe('09.876.543.2-000.000');
    expect(outNoId?.party_tax_id).toBeNull();
  });

  it('orders output faktur ahead of input faktur', async () => {
    await setPpnRate(10);
    await issueInvoice('o1', { unitPrice: 100, issuedAt: '2026-06-15' });
    await createBill(await createSupplier('i1'), 'B-i1', '2026-06-10', 110, 10);
    const all = await lines(...JUN);
    expect(all[0].side).toBe('output');
    expect(all[all.length - 1].side).toBe('input');
  });
});

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

async function seedRoles(): Promise<void> {
  await q(
    `insert into app_users(user_id, role) values($1,'admin'),($2,'viewer') on conflict do nothing`,
    [ADMIN, VIEWER],
  );
}

interface Issued {
  docId: string;
  total: number;
  documentNumber: string;
  orderId: string;
}

/**
 * Create an order with a single priced line and issue it as an invoice (as ADMIN).
 * `tag` keeps warehouse/product/customer/order codes unique across fixtures in one
 * test. Returns the issued invoice's id, its stamped claim (total), number, and order.
 */
async function issuedInvoice(tag: string, unitPrice: number, quantity: number): Promise<Issued> {
  await seedRoles();
  const wh = await createWarehouse(`WH-${tag}`);
  const p = await createProduct(`SKU-${tag}`, 'ml');
  const [cust] = await q<{ id: string }>(
    `insert into customers(code,name,tax_exempt) values($1,$1,true) returning id`,
    [`C-${tag}`],
  );
  const [o] = await q<{ id: string }>(
    `select create_sales_order($1,$2,$3,'2026-07-01',$4::jsonb) as id`,
    [`SO-${tag}`, cust.id, wh, JSON.stringify([{ product_id: p, quantity, unit: 'ml', unit_price: unitPrice }])],
  );
  const docId = await asUser(ADMIN, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select issue_document('invoice',$1,null) as id`, [o.id]);
    return rows[0].id;
  });
  const [doc] = await q<{ total: string; document_number: string }>(
    `select total, document_number from issued_documents where id=$1`,
    [docId],
  );
  return { docId, total: Number(doc.total), documentNumber: doc.document_number, orderId: o.id };
}

/** The one receivables row for an order (the order-page derivation). */
async function receivable(orderId: string) {
  const [row] = await q<any>(`select * from invoice_receivables($1)`, [orderId]);
  return row;
}

describe('invoice payments', () => {
  it('records a payment with trimmed method and reference, attributed to the admin', async () => {
    const inv = await issuedInvoice('rec', 100, 1);
    expect(inv.total).toBe(100);

    await asUser(ADMIN, (c) =>
      c.query(`select record_invoice_payment($1, 40.00, '2026-07-02', '  QRIS  ', '  TRX-1  ')`, [inv.docId]),
    );

    const [pay] = await q<any>(`select * from invoice_payments where issued_document_id=$1`, [inv.docId]);
    expect(Number(pay.amount)).toBe(40);
    expect(pay.paid_date.toISOString().slice(0, 10)).toBe('2026-07-02');
    expect(pay.method).toBe('QRIS'); // btrim'd
    expect(pay.reference).toBe('TRX-1'); // btrim'd
    expect(pay.recorded_by).toBe(ADMIN); // auth.uid()
  });

  it('derives open → partially_paid → paid across payments (the single derivation)', async () => {
    const inv = await issuedInvoice('deriv', 100, 1);

    let r = await receivable(inv.orderId);
    expect(r.status).toBe('open');
    expect(Number(r.paid)).toBe(0);
    expect(Number(r.open)).toBe(100);
    expect(r.payment_count).toBe(0);

    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 40)`, [inv.docId]));
    r = await receivable(inv.orderId);
    expect(r.status).toBe('partially_paid');
    expect(Number(r.paid)).toBe(40);
    expect(Number(r.open)).toBe(60);

    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 60)`, [inv.docId]));
    r = await receivable(inv.orderId);
    expect(r.status).toBe('paid');
    expect(Number(r.paid)).toBe(100);
    expect(Number(r.open)).toBe(0);
    expect(r.payment_count).toBe(2);
  });

  it('makes the claim the paper figure: a sub-cent snapshot residue is collectible at 2 dp', async () => {
    // 3.5 × 10.1234 = 35.4319 raw; the paper — and the claim — reads 35.43.
    const inv = await issuedInvoice('residue', 10.1234, 3.5);
    expect(inv.total).toBeCloseTo(35.43, 6);

    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 35.43)`, [inv.docId]));
    const r = await receivable(inv.orderId);
    expect(r.status).toBe('paid');
    expect(Number(r.open)).toBe(0);

    // not a cent more than the rounded claim
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 0.01)`, [inv.docId])),
    ).rejects.toThrow(/exceeds the open balance/i);
  });

  it('rejects overpayment (naming the balance and number), sub-cent precision, and non-positive amounts', async () => {
    const inv = await issuedInvoice('reject', 50, 1);
    await asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 30)`, [inv.docId]));

    // 30 already paid; 20.01 breaches the 20.00 balance — message names both figures.
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 20.01)`, [inv.docId])),
    ).rejects.toThrow(new RegExp(`exceeds the open balance of 20\\.00 on ${inv.documentNumber}`, 'i'));

    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 1.005)`, [inv.docId])),
    ).rejects.toThrow(/at most 2 decimal places/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 0)`, [inv.docId])),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, -5)`, [inv.docId])),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('records payments against issued invoices only — not other document kinds', async () => {
    await seedRoles();
    const wh = await createWarehouse('WH-ps');
    const p = await createProduct('SKU-ps', 'ml');
    const [cust] = await q<{ id: string }>(`insert into customers(code,name,tax_exempt) values('C-ps','C-ps',true) returning id`);
    const [o] = await q<{ id: string }>(
      `select create_sales_order('SO-ps',$1,$2,'2026-07-01',$3::jsonb) as id`,
      [cust.id, wh, JSON.stringify([{ product_id: p, quantity: 1, unit: 'ml', unit_price: 10 }])],
    );
    const psId = await asUser(ADMIN, async (c) => {
      const { rows } = await c.query<{ id: string }>(`select issue_document('packing_slip',$1,null) as id`, [o.id]);
      return rows[0].id;
    });
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 5)`, [psId])),
    ).rejects.toThrow(/against issued invoices only/i);
  });

  it('refuses a payment against a voided invoice', async () => {
    const inv = await issuedInvoice('voidpay', 100, 1);
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1, 'issued in error')`, [inv.docId]));
    await expect(
      asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 10)`, [inv.docId])),
    ).rejects.toThrow(/voided/i);
  });

  it('gates a payment behind admin clearance', async () => {
    const inv = await issuedInvoice('vwrite', 100, 1);
    await expect(
      asUser(VIEWER, (c) => c.query(`select record_invoice_payment($1, 10)`, [inv.docId])),
    ).rejects.toThrow(/administrator/i);
    // and the rejected attempt recorded nothing
    const [{ n }] = await q<{ n: string }>(`select count(*) n from invoice_payments where issued_document_id=$1`, [inv.docId]);
    expect(Number(n)).toBe(0);
  });

  it('voids only with admin clearance, a reason, and a not-already-void target', async () => {
    const inv = await issuedInvoice('void', 100, 1);

    await expect(
      asUser(VIEWER, (c) => c.query(`select void_issued_document($1, 'nope')`, [inv.docId])),
    ).rejects.toThrow(/administrator/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select void_issued_document($1, '')`, [inv.docId])),
    ).rejects.toThrow(/reason is required/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select void_issued_document($1, '   ')`, [inv.docId])),
    ).rejects.toThrow(/reason is required/i);

    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1, '  wrong customer  ')`, [inv.docId]));
    const [d] = await q<any>(`select voided_at, voided_by, void_reason from issued_documents where id=$1`, [inv.docId]);
    expect(d.voided_at).not.toBeNull();
    expect(d.voided_by).toBe(ADMIN);
    expect(d.void_reason).toBe('wrong customer'); // btrim'd

    await expect(
      asUser(ADMIN, (c) => c.query(`select void_issued_document($1, 'again')`, [inv.docId])),
    ).rejects.toThrow(/already voided/i);
    await expect(
      asUser(ADMIN, (c) => c.query(`select void_issued_document('00000000-0000-0000-0000-000000000000', 'x')`)),
    ).rejects.toThrow(/not found/i);
  });

  it('will not void an invoice that carries payments until they are removed', async () => {
    const inv = await issuedInvoice('voidguard', 100, 1);
    const payId = await asUser(ADMIN, async (c) => {
      const { rows } = await c.query<{ id: string }>(`select record_invoice_payment($1, 40) as id`, [inv.docId]);
      return rows[0].id;
    });
    await expect(
      asUser(ADMIN, (c) => c.query(`select void_issued_document($1, 'change of heart')`, [inv.docId])),
    ).rejects.toThrow(/cannot be voided/i);

    // remove the payment, and the void goes through
    await asUser(ADMIN, (c) => c.query(`select delete_invoice_payment($1)`, [payId]));
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1, 'change of heart')`, [inv.docId]));
    const r = await receivable(inv.orderId);
    expect(r.status).toBe('void');
  });

  it('reopens the balance when a payment is deleted, admin-only', async () => {
    const inv = await issuedInvoice('del', 100, 1);
    const payId = await asUser(ADMIN, async (c) => {
      const { rows } = await c.query<{ id: string }>(`select record_invoice_payment($1, 100) as id`, [inv.docId]);
      return rows[0].id;
    });
    expect((await receivable(inv.orderId)).status).toBe('paid');

    await expect(
      asUser(VIEWER, (c) => c.query(`select delete_invoice_payment($1)`, [payId])),
    ).rejects.toThrow(/administrator/i);

    await asUser(ADMIN, (c) => c.query(`select delete_invoice_payment($1)`, [payId]));
    const r = await receivable(inv.orderId);
    expect(r.status).toBe('open');
    expect(Number(r.open)).toBe(100);

    await expect(
      asUser(ADMIN, (c) => c.query(`select delete_invoice_payment('00000000-0000-0000-0000-000000000000')`)),
    ).rejects.toThrow(/not found/i);
  });

  it('serializes concurrent payments so none breaches the claim', async () => {
    const inv = await issuedInvoice('race', 100, 1);
    // Five payments of 30 fired at once; the invoice row lock serializes them, so
    // exactly three fit inside 100 and two are turned away.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        asUser(ADMIN, (c) => c.query(`select record_invoice_payment($1, 30)`, [inv.docId])),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(2);

    const [{ sum }] = await q<{ sum: string }>(
      `select coalesce(sum(amount),0) sum from invoice_payments where issued_document_id=$1`,
      [inv.docId],
    );
    expect(Number(sum)).toBe(90); // never 120 or 150
    const r = await receivable(inv.orderId);
    expect(Number(r.open)).toBe(10);
    expect(r.status).toBe('partially_paid');
  });

  it('shows a voided invoice in the register as void, with its reason', async () => {
    const inv = await issuedInvoice('reg', 100, 1);
    await asUser(ADMIN, (c) => c.query(`select void_issued_document($1, 'duplicate of INV-earlier')`, [inv.docId]));
    const r = await receivable(inv.orderId);
    expect(r.status).toBe('void');
    expect(r.void_reason).toBe('duplicate of INV-earlier');
    expect(Number(r.paid)).toBe(0);
  });

  it('locks the payments table against direct client writes', async () => {
    const inv = await issuedInvoice('lock', 100, 1);
    await expect(
      asUser(ADMIN, (c) =>
        c.query(`insert into invoice_payments(issued_document_id, amount) values($1, 10)`, [inv.docId]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

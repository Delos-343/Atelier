import { describe, it, expect } from 'vitest';
import { summariseStatement, type AgedInvoice } from '../receivables';

const inv = (bucket: AgedInvoice['bucket'], open: number): AgedInvoice => ({
  issuedDocumentId: 'x',
  documentNumber: 'INV',
  issuedAt: '2026-06-01',
  dueDate: '2026-07-01',
  daysOverdue: 0,
  bucket,
  total: open,
  paid: 0,
  open,
});

describe('summariseStatement', () => {
  it('sums open balances into their buckets and a grand total', () => {
    const { buckets, outstanding } = summariseStatement([
      inv('current', 100),
      inv('current', 50),
      inv('d1_30', 30),
      inv('d90_plus', 20),
    ]);
    expect(buckets.current).toBe(150);
    expect(buckets.d1_30).toBe(30);
    expect(buckets.d31_60).toBe(0);
    expect(buckets.d61_90).toBe(0);
    expect(buckets.d90_plus).toBe(20);
    expect(outstanding).toBe(200);
  });

  it('returns zeroed buckets and nil outstanding for no invoices', () => {
    const { buckets, outstanding } = summariseStatement([]);
    expect(outstanding).toBe(0);
    expect(buckets.current).toBe(0);
    expect(buckets.d90_plus).toBe(0);
  });
});

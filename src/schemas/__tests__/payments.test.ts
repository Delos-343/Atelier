import { describe, it, expect } from 'vitest';
import { recordPaymentSchema, voidDocumentSchema } from '../payments';

describe('recordPaymentSchema', () => {
  it('accepts a well-formed payment and defaults method/reference to empty strings', () => {
    const parsed = recordPaymentSchema.parse({ amount: 125.5, paidDate: '2026-07-02' });
    expect(parsed.amount).toBe(125.5);
    expect(parsed.paidDate).toBe('2026-07-02');
    expect(parsed.method).toBe('');
    expect(parsed.reference).toBe('');
  });

  it('trims method and reference and carries them through', () => {
    const parsed = recordPaymentSchema.parse({
      amount: 10,
      paidDate: '2026-07-02',
      method: '  QRIS  ',
      reference: '  TRX-9  ',
    });
    expect(parsed.method).toBe('QRIS');
    expect(parsed.reference).toBe('TRX-9');
  });

  it('rejects non-positive amounts and more than two decimal places', () => {
    expect(recordPaymentSchema.safeParse({ amount: 0, paidDate: '2026-07-02' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: -1, paidDate: '2026-07-02' }).success).toBe(false);
    const threeDp = recordPaymentSchema.safeParse({ amount: 1.005, paidDate: '2026-07-02' });
    expect(threeDp.success).toBe(false);
    if (!threeDp.success) expect(threeDp.error.issues[0].message).toMatch(/2 decimal places/i);
    // exactly two decimals is fine
    expect(recordPaymentSchema.safeParse({ amount: 1.01, paidDate: '2026-07-02' }).success).toBe(true);
  });

  it('rejects a malformed date and a non-numeric or infinite amount', () => {
    expect(recordPaymentSchema.safeParse({ amount: 10, paidDate: '07/02/2026' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: 10, paidDate: '2026-7-2' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: 'ten', paidDate: '2026-07-02' }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ amount: Infinity, paidDate: '2026-07-02' }).success).toBe(false);
  });

  it('rejects an over-length method or reference', () => {
    expect(
      recordPaymentSchema.safeParse({ amount: 10, paidDate: '2026-07-02', method: 'x'.repeat(61) }).success,
    ).toBe(false);
    expect(
      recordPaymentSchema.safeParse({ amount: 10, paidDate: '2026-07-02', reference: 'x'.repeat(121) }).success,
    ).toBe(false);
  });
});

describe('voidDocumentSchema', () => {
  it('accepts a reason and trims it', () => {
    expect(voidDocumentSchema.parse({ reason: '  wrong customer  ' }).reason).toBe('wrong customer');
  });

  it('requires a non-empty reason within the length limit', () => {
    expect(voidDocumentSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(voidDocumentSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(voidDocumentSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(voidDocumentSchema.safeParse({ reason: 'duplicate' }).success).toBe(true);
  });
});

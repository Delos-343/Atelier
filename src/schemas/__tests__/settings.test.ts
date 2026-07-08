import { describe, it, expect } from 'vitest';
import { productCostingRateSchema } from '../settings';

const PID = '00000000-0000-0000-0000-000000000001';

describe('productCostingRateSchema', () => {
  it('coerces both rates and keeps a valid override', () => {
    const r = productCostingRateSchema.safeParse({
      productId: PID,
      laborRatePerHour: '20',
      overheadRate: '0.15',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.laborRatePerHour).toBe(20);
      expect(r.data.overheadRate).toBeCloseTo(0.15, 6);
    }
  });

  it('treats an empty field as null (inherit) rather than zero', () => {
    const r = productCostingRateSchema.safeParse({
      productId: PID,
      laborRatePerHour: '',
      overheadRate: '0.2',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.laborRatePerHour).toBeNull();
      expect(r.data.overheadRate).toBeCloseTo(0.2, 6);
    }
  });

  it('accepts an explicit null field as inherit', () => {
    const r = productCostingRateSchema.safeParse({
      productId: PID,
      laborRatePerHour: 12,
      overheadRate: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.laborRatePerHour).toBe(12);
      expect(r.data.overheadRate).toBeNull();
    }
  });

  it('rejects an all-inherit override (both blank) — that is a removal, not a save', () => {
    const r = productCostingRateSchema.safeParse({
      productId: PID,
      laborRatePerHour: '',
      overheadRate: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative rate and a malformed product id', () => {
    expect(
      productCostingRateSchema.safeParse({
        productId: PID,
        laborRatePerHour: '-1',
        overheadRate: null,
      }).success,
    ).toBe(false);
    expect(
      productCostingRateSchema.safeParse({
        productId: 'not-a-uuid',
        laborRatePerHour: 5,
        overheadRate: null,
      }).success,
    ).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { publicMetricsSchema, dashboardSchema } from '../metrics-schemas';

describe('metric RPC payload validation', () => {
  describe('publicMetricsSchema', () => {
    const valid = {
      lots_total: 10,
      lots_available: 6,
      lots_quarantine: 2,
      products_total: 4,
      materials_total: 8,
      production_total: 3,
      production_completed: 1,
      qc_pass_rate: 0.8333,
    };

    it('accepts a well-formed payload', () => {
      expect(publicMetricsSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts a null qc_pass_rate (no QC checks recorded)', () => {
      expect(publicMetricsSchema.safeParse({ ...valid, qc_pass_rate: null }).success).toBe(true);
    });

    it('rejects a missing field rather than coercing it to NaN', () => {
      const { lots_total: _omit, ...missing } = valid;
      expect(publicMetricsSchema.safeParse(missing).success).toBe(false);
    });

    it('rejects a stringified number (shape drift)', () => {
      expect(publicMetricsSchema.safeParse({ ...valid, lots_total: '10' }).success).toBe(false);
    });

    it('ignores unknown additive keys', () => {
      expect(publicMetricsSchema.safeParse({ ...valid, new_metric: 5 }).success).toBe(true);
    });
  });

  describe('dashboardSchema', () => {
    const valid = {
      inventory: {
        value_raw: 1234.5,
        value_finished: 320.0,
        lots_by_status: { available: 6, quarantine: 2 },
        value_by_category: [{ category: 'solvent', value: 500 }],
      },
      production: { by_status: { planned: 2, completed: 1 }, total: 3 },
      qc: { passed: 5, failed: 1, pending: 2, pass_rate: 0.8333 },
    };

    it('accepts a well-formed payload', () => {
      expect(dashboardSchema.safeParse(valid).success).toBe(true);
    });

    it('accepts empty maps/arrays and null pass_rate (empty database)', () => {
      const empty = {
        inventory: { value_raw: 0, value_finished: 0, lots_by_status: {}, value_by_category: [] },
        production: { by_status: {}, total: 0 },
        qc: { passed: 0, failed: 0, pending: 0, pass_rate: null },
      };
      expect(dashboardSchema.safeParse(empty).success).toBe(true);
    });

    it('rejects a malformed category entry (drift)', () => {
      const bad = {
        ...valid,
        inventory: { ...valid.inventory, value_by_category: [{ category: 'x' }] },
      };
      expect(dashboardSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects a non-numeric value in a status map', () => {
      const bad = {
        ...valid,
        production: { ...valid.production, by_status: { planned: 'two' } },
      };
      expect(dashboardSchema.safeParse(bad).success).toBe(false);
    });
  });
});

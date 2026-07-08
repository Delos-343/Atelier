import { describe, it, expect } from 'vitest';
import { Decimal } from '../decimal';
import { explodeFormula, validateFormula, FormulaInput } from '../formula';
import { convert } from '../units';

const sum = (rows: { quantity: string }[]) =>
  rows.reduce((a, r) => a.plus(r.quantity), new Decimal(0));

describe('unit conversion', () => {
  it('converts within mass', () => {
    expect(convert(1, 'kg', 'g').toString()).toBe('1000');
    expect(convert(500, 'mg', 'g').toString()).toBe('0.5');
  });

  it('converts within volume', () => {
    expect(convert(2, 'l', 'ml').toString()).toBe('2000');
  });

  it('converts mass<->volume with density', () => {
    // 1000 g of ethanol (0.789 g/ml) ~ 1267.43 ml
    expect(convert(1000, 'g', 'ml', 0.789).toDecimalPlaces(2).toString()).toBe('1267.43');
  });

  it('throws on cross-dimension without density', () => {
    expect(() => convert(1, 'g', 'ml')).toThrow(/density/);
  });
});

describe('validateFormula', () => {
  it('rejects percent components that do not sum to 100', () => {
    const f: FormulaInput = {
      basis: 'percent',
      components: [
        { rawMaterialId: 'A', quantity: 50, unit: 'g' },
        { rawMaterialId: 'B', quantity: 49, unit: 'g' },
      ],
    };
    expect(validateFormula(f)).toContainEqual(expect.stringMatching(/sum to 99/));
  });

  it('rejects duplicate and non-positive components', () => {
    const f: FormulaInput = {
      basis: 'mass',
      components: [
        { rawMaterialId: 'A', quantity: 10, unit: 'g' },
        { rawMaterialId: 'A', quantity: 0, unit: 'g' },
      ],
    };
    const errs = validateFormula(f);
    expect(errs.some((e) => /duplicate/.test(e))).toBe(true);
    expect(errs.some((e) => /must be > 0/.test(e))).toBe(true);
  });
});

describe('explodeFormula — percent basis', () => {
  it('scales a clean formula to batch weight', () => {
    const f: FormulaInput = {
      basis: 'percent',
      components: [
        { rawMaterialId: 'A', quantity: 80, unit: 'g' },
        { rawMaterialId: 'B', quantity: 15, unit: 'g' },
        { rawMaterialId: 'C', quantity: 5, unit: 'g' },
      ],
    };
    const out = explodeFormula(f, 5000, 'g', 3);
    expect(out.map((r) => r.quantity)).toEqual(['4000.000', '750.000', '250.000']);
    expect(sum(out).toString()).toBe('5000');
  });

  it('apportions rounding so the sum is exact', () => {
    const f: FormulaInput = {
      basis: 'percent',
      components: [
        { rawMaterialId: 'A', quantity: 33.333, unit: 'g' },
        { rawMaterialId: 'B', quantity: 33.333, unit: 'g' },
        { rawMaterialId: 'C', quantity: 33.334, unit: 'g' },
      ],
    };
    const out = explodeFormula(f, 100, 'g', 2);
    // sum must be exactly the target — no drift
    expect(sum(out).toFixed(2)).toBe('100.00');
    // leftover cent goes to the largest remainder (component C)
    expect(out[2].quantity).toBe('33.34');
  });
});

describe('explodeFormula — mass basis', () => {
  it('normalizes absolute masses and converts units', () => {
    const f: FormulaInput = {
      basis: 'mass',
      components: [
        { rawMaterialId: 'A', quantity: 800, unit: 'g' },
        { rawMaterialId: 'B', quantity: 150, unit: 'g' },
        { rawMaterialId: 'C', quantity: 50, unit: 'g' },
      ],
    };
    const out = explodeFormula(f, 2, 'kg', 3); // 1000 g recipe -> 2 kg batch
    expect(out.map((r) => r.quantity)).toEqual(['1.600', '0.300', '0.100']);
    expect(sum(out).toString()).toBe('2');
  });
});

describe('exact-sum invariant (property)', () => {
  it('holds across many random percent splits', () => {
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(Math.random() * 6);
      // random positive weights, expressed as percentages summing to 100
      const weights = Array.from({ length: n }, () => 1 + Math.random() * 99);
      const total = weights.reduce((a, b) => a + b, 0);
      const pcts = weights.map((w) => (w / total) * 100);
      // fix the last percent so the displayed inputs sum to exactly 100
      const fixed = pcts.slice(0, -1);
      const last = 100 - fixed.reduce((a, b) => a + b, 0);
      const components = [...fixed, last].map((p, i) => ({
        rawMaterialId: `M${i}`,
        quantity: new Decimal(p).toDecimalPlaces(4).toNumber(),
        unit: 'g' as const,
      }));
      const target = 100 + Math.floor(Math.random() * 9900);
      const out = explodeFormula({ basis: 'percent', components }, target, 'g', 3);
      expect(sum(out).toString()).toBe(new Decimal(target).toString());
    }
  });
});

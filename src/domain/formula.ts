import { Decimal } from './decimal';
import { convert, Unit } from './units';

export interface FormulaComponentInput {
  rawMaterialId: string;
  /** percent (basis='percent') or absolute mass/volume (basis='mass') */
  quantity: number | string;
  unit: Unit;
  densityGPerMl?: number;
}

export interface FormulaInput {
  basis: 'percent' | 'mass';
  components: FormulaComponentInput[];
}

export interface ExplodedComponent {
  rawMaterialId: string;
  /** fixed to `scale` decimals, in targetUnit; the set sums EXACTLY to target */
  quantity: string;
  unit: Unit;
}

const PERCENT_TOLERANCE = new Decimal('0.01');

/** Returns a list of human-readable problems; empty array means valid. */
export function validateFormula(f: FormulaInput): string[] {
  const errors: string[] = [];
  if (!f.components.length) errors.push('formula has no components');

  const seen = new Set<string>();
  for (const c of f.components) {
    if (seen.has(c.rawMaterialId)) errors.push(`duplicate component ${c.rawMaterialId}`);
    seen.add(c.rawMaterialId);
    if (!new Decimal(c.quantity).gt(0)) {
      errors.push(`component ${c.rawMaterialId} quantity must be > 0`);
    }
  }

  if (f.basis === 'percent') {
    const sum = f.components.reduce((a, c) => a.plus(c.quantity), new Decimal(0));
    if (sum.minus(100).abs().gt(PERCENT_TOLERANCE)) {
      errors.push(`percent components sum to ${sum.toString()}, expected 100`);
    }
  }
  return errors;
}

/**
 * Explode a formula to a concrete batch.
 * Works by proportion (component weight / total weight) so the result always
 * sums to exactly `targetQuantity` regardless of basis or rounding.
 */
export function explodeFormula(
  f: FormulaInput,
  targetQuantity: number | string,
  targetUnit: Unit,
  scale = 3,
): ExplodedComponent[] {
  const errs = validateFormula(f);
  if (errs.length) throw new Error(`invalid formula: ${errs.join('; ')}`);

  const target = new Decimal(targetQuantity).toDecimalPlaces(scale);
  if (target.lte(0)) throw new Error('target quantity must be > 0');

  // weight per component, comparable in targetUnit
  const weights = f.components.map((c) => ({
    id: c.rawMaterialId,
    w:
      f.basis === 'percent'
        ? new Decimal(c.quantity)
        : convert(c.quantity, c.unit, targetUnit, c.densityGPerMl),
  }));

  const totalW = weights.reduce((a, x) => a.plus(x.w), new Decimal(0));
  if (totalW.lte(0)) throw new Error('formula total weight must be > 0');

  // unrounded proportional amounts (sum == target, full precision)
  const raw = weights.map((x) => ({ id: x.id, amount: target.mul(x.w).div(totalW) }));

  return largestRemainder(raw, target, scale).map((r) => ({
    rawMaterialId: r.id,
    quantity: r.amount.toFixed(scale),
    unit: targetUnit,
  }));
}

/**
 * Hamilton (largest-remainder) apportionment: floor every amount to `scale`
 * decimals, then hand the leftover smallest-units to the largest fractional
 * remainders so the rounded set sums to exactly `target`.
 */
function largestRemainder(
  raw: { id: string; amount: Decimal }[],
  target: Decimal,
  scale: number,
): { id: string; amount: Decimal }[] {
  const step = new Decimal(10).pow(-scale); // smallest representable unit
  const items = raw.map((r) => {
    const floor = r.amount.toDecimalPlaces(scale, Decimal.ROUND_DOWN);
    return { id: r.id, amount: floor, remainder: r.amount.minus(floor) };
  });

  const sumFloor = items.reduce((a, x) => a.plus(x.amount), new Decimal(0));
  const deficitUnits = target
    .minus(sumFloor)
    .div(step)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();

  // largest remainder first; ties resolved by original order (stable)
  const order = items
    .map((x, i) => ({ i, rem: x.remainder }))
    .sort((a, b) => b.rem.cmp(a.rem) || a.i - b.i);

  // deficit is in [0, count); round-robin guards against any precision edge
  for (let k = 0; k < deficitUnits; k++) {
    const idx = order[k % order.length].i;
    items[idx].amount = items[idx].amount.plus(step);
  }

  return items.map(({ id, amount }) => ({ id, amount }));
}

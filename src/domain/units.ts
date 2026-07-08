import { Decimal } from './decimal';

export type Unit = 'kg' | 'g' | 'mg' | 'l' | 'ml';

// canonical factors: mass -> grams, volume -> millilitres
const MASS: Record<string, Decimal> = {
  kg: new Decimal(1000),
  g: new Decimal(1),
  mg: new Decimal('0.001'),
};
const VOL: Record<string, Decimal> = {
  l: new Decimal(1000),
  ml: new Decimal(1),
};

const isMass = (u: Unit): boolean => u in MASS;
const isVol = (u: Unit): boolean => u in VOL;

/**
 * Convert a quantity between units.
 * - within mass (kg/g/mg) or within volume (l/ml): exact factor conversion
 * - across mass<->volume: requires density in g/ml, else throws
 */
export function convert(
  qty: Decimal.Value,
  from: Unit,
  to: Unit,
  densityGPerMl?: number,
): Decimal {
  const q = new Decimal(qty);
  if (from === to) return q;

  if (isMass(from) && isMass(to)) return q.mul(MASS[from]).div(MASS[to]);
  if (isVol(from) && isVol(to)) return q.mul(VOL[from]).div(VOL[to]);

  if (densityGPerMl == null || densityGPerMl <= 0) {
    throw new Error(`density (g/ml) required to convert ${from} -> ${to}`);
  }
  const d = new Decimal(densityGPerMl);

  if (isMass(from)) {
    const grams = q.mul(MASS[from]); // -> g
    const ml = grams.div(d); // g -> ml
    return ml.div(VOL[to]);
  }
  const ml = q.mul(VOL[from]); // -> ml
  const grams = ml.mul(d); // ml -> g
  return grams.div(MASS[to]);
}

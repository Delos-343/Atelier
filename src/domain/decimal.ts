import Decimal from 'decimal.js';

// 28 significant digits, banker-safe half-up rounding for manufacturing math.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

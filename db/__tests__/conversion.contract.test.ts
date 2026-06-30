import { describe, it, expect, afterAll } from 'vitest';
import { pool, q } from './helpers';
import { convert, type Unit } from '../../src/domain/units';

afterAll(async () => {
  await pool.end();
});

interface Case {
  qty: number;
  from: Unit;
  to: Unit;
  density?: number;
}

// Golden matrix: if SQL convert_qty and TS convert ever disagree here, one drifted.
const CASES: Case[] = [
  { qty: 1, from: 'kg', to: 'g' },
  { qty: 1500, from: 'g', to: 'kg' },
  { qty: 2500, from: 'mg', to: 'g' },
  { qty: 3, from: 'g', to: 'mg' },
  { qty: 2, from: 'l', to: 'ml' },
  { qty: 750, from: 'ml', to: 'l' },
  { qty: 1000, from: 'g', to: 'ml', density: 0.789 }, // ethanol
  { qty: 500, from: 'ml', to: 'g', density: 0.92 },
  { qty: 1, from: 'kg', to: 'l', density: 0.85 },
  { qty: 2, from: 'l', to: 'kg', density: 1.05 },
];

describe('unit conversion contract (SQL ≡ TS)', () => {
  it('agrees on every case to 6 decimal places', async () => {
    for (const c of CASES) {
      const [row] = await q<{ convert_qty: string }>(
        `select convert_qty($1,$2,$3,$4) as convert_qty`,
        [c.qty, c.from, c.to, c.density ?? null],
      );
      const sql = Number(row.convert_qty).toFixed(6);
      const ts = convert(c.qty, c.from, c.to, c.density).toFixed(6);
      expect(`${c.qty}${c.from}->${c.to}: ${ts}`).toBe(`${c.qty}${c.from}->${c.to}: ${sql}`);
    }
  });
});

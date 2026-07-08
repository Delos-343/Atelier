import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll, createWarehouse, createProduct } from './helpers';

beforeEach(truncateAll);
afterAll(async () => {
  await pool.end();
});

/**
 * The shared lot-creation primitive. It is exercised end-to-end by the production and
 * returns suites; these pin its contract directly: a lot is born empty (on-hand 0) with
 * exactly the attributes passed, and the status/unit-cost defaults behave.
 */
describe('_create_lot primitive', () => {
  it('creates an empty lot with the given attributes', async () => {
    const wh = await createWarehouse('CL1');
    const prod = await createProduct('CL-P1', 'g');
    const [{ _create_lot: lotId }] = await q<{ _create_lot: string }>(
      `select _create_lot('CL-LOT1','product',null,$1,$2,'g','quarantine',12.5) as _create_lot`,
      [prod, wh],
    );
    const [lot] = await q(
      `select item_type, status, unit, quantity_on_hand, unit_cost, product_id, warehouse_id, raw_material_id
         from inventory_lots where id=$1`,
      [lotId],
    );
    expect(lot.item_type).toBe('product');
    expect(lot.status).toBe('quarantine');
    expect(lot.unit).toBe('g');
    expect(Number(lot.quantity_on_hand)).toBe(0); // born empty; stock arrives via post_movement
    expect(Number(lot.unit_cost)).toBeCloseTo(12.5, 6);
    expect(lot.product_id).toBe(prod);
    expect(lot.warehouse_id).toBe(wh);
    expect(lot.raw_material_id).toBeNull();
  });

  it('defaults to an available lot with no unit cost', async () => {
    const wh = await createWarehouse('CL2');
    const prod = await createProduct('CL-P2', 'g');
    const [{ _create_lot: lotId }] = await q<{ _create_lot: string }>(
      `select _create_lot('CL-LOT2','product',null,$1,$2,'g') as _create_lot`,
      [prod, wh],
    );
    const [lot] = await q(
      `select status, unit_cost, quantity_on_hand from inventory_lots where id=$1`,
      [lotId],
    );
    expect(lot.status).toBe('available');
    expect(lot.unit_cost).toBeNull();
    expect(Number(lot.quantity_on_hand)).toBe(0);
  });
});

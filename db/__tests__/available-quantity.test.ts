import { beforeEach, describe, expect, it } from 'vitest';
import { q, truncateAll, createWarehouse, createProduct } from './helpers';

/**
 * Insert a finished-goods lot directly. `expiryDays` is relative to the DB's
 * current_date (null = no expiry) so the date-boundary assertions can't drift
 * with the client timezone.
 */
async function makeProductLot(opts: {
  productId: string;
  warehouseId: string;
  lotCode: string;
  qty: number;
  unit?: string;
  status?: string;
  expiryDays?: number | null;
}): Promise<void> {
  await q(
    `insert into inventory_lots(lot_code,item_type,product_id,warehouse_id,quantity_on_hand,unit,status,expiry_date)
     values($1,'product',$2,$3,$4,$5,$6,
            case when $7::int is null then null else current_date + $7::int end)`,
    [
      opts.lotCode,
      opts.productId,
      opts.warehouseId,
      opts.qty,
      opts.unit ?? 'g',
      opts.status ?? 'available',
      opts.expiryDays ?? null,
    ],
  );
}

async function avail(productId: string, warehouseId: string, unit = 'g'): Promise<number> {
  const [r] = await q(`select product_available_quantity($1,$2,$3) as qty`, [
    productId,
    warehouseId,
    unit,
  ]);
  return Number(r.qty);
}

describe('product_available_quantity — finished-goods availability aggregate', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('sums only available, in-warehouse, in-unit, unexpired, on-hand>0 lots', async () => {
    const wh1 = await createWarehouse('AQ1');
    const wh2 = await createWarehouse('AQ2');
    const p = await createProduct('AQ-P1', 'g');

    // Counted.
    await makeProductLot({ productId: p, warehouseId: wh1, lotCode: 'A', qty: 100 });
    await makeProductLot({ productId: p, warehouseId: wh1, lotCode: 'B', qty: 50, expiryDays: 30 });

    // Each excluded for exactly one reason.
    await makeProductLot({ productId: p, warehouseId: wh1, lotCode: 'C', qty: 30, expiryDays: -1 }); // expired
    await makeProductLot({ productId: p, warehouseId: wh1, lotCode: 'D', qty: 40, status: 'quarantine' }); // not available
    await makeProductLot({ productId: p, warehouseId: wh2, lotCode: 'E', qty: 200 }); // other warehouse
    await makeProductLot({ productId: p, warehouseId: wh1, lotCode: 'F', qty: 70, unit: 'ml' }); // other unit

    expect(await avail(p, wh1, 'g')).toBe(150);
  });

  it('returns 0 rather than null when nothing matches', async () => {
    const wh = await createWarehouse('AQ3');
    const p = await createProduct('AQ-P2', 'g');
    expect(await avail(p, wh, 'g')).toBe(0);
  });

  it('is date-aware: a lot whose expiry is today still counts', async () => {
    const wh = await createWarehouse('AQ4');
    const p = await createProduct('AQ-P3', 'g');
    await makeProductLot({ productId: p, warehouseId: wh, lotCode: 'T', qty: 10, expiryDays: 0 });
    expect(await avail(p, wh, 'g')).toBe(10);
  });
});

import { Pool } from 'pg';

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/erp_test',
  max: 30,
});

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

const TABLES = [
  'lot_genealogy',
  'production_consumptions',
  'production_order_components',
  'qc_checks',
  'stock_movements',
  'production_orders',
  'sales_order_lines',
  'sales_orders',
  'customers',
  'inventory_lots',
  'formula_components',
  'formula_versions',
  'formulas',
  'products',
  'raw_materials',
  'warehouses',
  'app_users',
];

export async function truncateAll(): Promise<void> {
  await pool.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
}

export async function createWarehouse(code = 'WH1'): Promise<string> {
  const [r] = await q(
    `insert into warehouses(code,name) values($1,$1) returning id`,
    [code],
  );
  return r.id;
}

export async function createRawMaterial(opts: {
  sku: string;
  unit?: string;
  density?: number | null;
}): Promise<string> {
  const [r] = await q(
    `insert into raw_materials(sku,name,category,base_unit,density_g_per_ml)
     values($1,$1,'aroma_chemical',$2,$3) returning id`,
    [opts.sku, opts.unit ?? 'g', opts.density ?? null],
  );
  return r.id;
}

export async function createProduct(sku: string, unit = 'g'): Promise<string> {
  const [r] = await q(
    `insert into products(sku,name,base_unit) values($1,$1,$2) returning id`,
    [sku, unit],
  );
  return r.id;
}

/** Creates a raw lot at 0 and posts a 'receipt' so on_hand == SUM(movements). */
export async function createRawLot(opts: {
  materialId: string;
  warehouseId: string;
  lotCode: string;
  qty: number;
  unit?: string;
  expiry?: string | null;
  status?: string;
}): Promise<string> {
  const unit = opts.unit ?? 'g';
  const [lot] = await q(
    `insert into inventory_lots(lot_code,item_type,raw_material_id,warehouse_id,unit,status,expiry_date)
     values($1,'raw',$2,$3,$4,$5,$6) returning id`,
    [opts.lotCode, opts.materialId, opts.warehouseId, unit, opts.status ?? 'available', opts.expiry ?? null],
  );
  await q(`select post_movement($1,'receipt',$2,$3,null,null,null)`, [lot.id, opts.qty, unit]);
  return lot.id;
}

export async function onHand(lotId: string): Promise<string> {
  const [r] = await q(`select quantity_on_hand from inventory_lots where id=$1`, [lotId]);
  return r.quantity_on_hand;
}

export async function lotStatus(lotId: string): Promise<string> {
  const [r] = await q(`select status from inventory_lots where id=$1`, [lotId]);
  return r.status;
}

/** Reconciliation invariant: on_hand must equal the signed sum of its movements. */
export async function reconcile(lotId: string): Promise<boolean> {
  const [r] = await q(
    `select il.quantity_on_hand as on_hand,
            coalesce(sum(sm.quantity),0) as ledger
       from inventory_lots il
       left join stock_movements sm on sm.lot_id = il.id
      where il.id=$1
      group by il.quantity_on_hand`,
    [lotId],
  );
  return Number(r.on_hand) === Number(r.ledger);
}

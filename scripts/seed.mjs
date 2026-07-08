// Seed a realistic demo dataset so the console and dashboard have shape:
//   - one main warehouse + a second (R&D) warehouse
//   - five raw materials with densities AND standard costs (drives value charts)
//   - a product, and a locked percent formula that sums to 100
//   - received raw-material lots created through post_movement (ledger-consistent)
//   - three COMPLETED production runs through complete_production_order, each
//     yielding a quarantined finished lot, then QC'd: one passed (-> available),
//     one left pending (-> stays quarantine), one failed (-> rejected)
//   - a planned and an in-progress order so the pipeline shows every stage
//
//   node scripts/seed.mjs        # seeds the database in DATABASE_URL
//
// Idempotent: fixed UUIDs + ON CONFLICT, and stock-moving / order-completing
// steps run only when their row is newly inserted, so re-running is safe.
//
// Use db:migrate / db:test:setup first so the schema exists.

import pg from 'pg';
import { loadEnvFiles, resolvePgUrl } from './_env.mjs';

loadEnvFiles();
const url = resolvePgUrl();

const WAREHOUSE = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE_RND = '11111111-1111-4111-8111-222222222222';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const FORMULA = '33333333-3333-4333-8333-333333333333';
const FORMULA_VERSION = '44444444-4444-4444-8444-444444444444';

// raw materials: id, sku, name, category, base unit, density (g/ml), cost/unit, formula %, received qty
const MATERIALS = [
  { id: 'aaaaaaa1-0000-4000-8000-000000000001', sku: 'RM-BERG', name: 'Bergamot Essential Oil', category: 'essential_oil', unit: 'g', density: 0.876, cost: 0.65, pct: 12, qty: 5000 },
  { id: 'aaaaaaa1-0000-4000-8000-000000000002', sku: 'RM-HEDIONE', name: 'Hedione', category: 'aroma_chemical', unit: 'g', density: 1.0, cost: 0.12, pct: 30, qty: 5000 },
  { id: 'aaaaaaa1-0000-4000-8000-000000000003', sku: 'RM-ISOE', name: 'Iso E Super', category: 'aroma_chemical', unit: 'g', density: 0.945, cost: 0.28, pct: 18, qty: 5000 },
  { id: 'aaaaaaa1-0000-4000-8000-000000000004', sku: 'RM-ETOH', name: 'Perfumers Alcohol', category: 'solvent', unit: 'ml', density: 0.789, cost: 0.04, pct: 35, qty: 5000 },
  { id: 'aaaaaaa1-0000-4000-8000-000000000005', sku: 'RM-DPG', name: 'Dipropylene Glycol', category: 'solvent', unit: 'g', density: 1.022, cost: 0.03, pct: 5, qty: 2000 },
];
const LOT_PREFIX = 'bbbbbbb1-0000-4000-8000-00000000000';

// production runs: id, code, status, (for completed) finished lot code + qc outcome
const BATCH_QTY = 1000; // g of finished goods per completed run
const RUNS = [
  { id: '55555555-0000-4000-8000-000000000001', code: 'PO-0001', status: 'completed', lot: 'FG-NO5-L01', qc: 'passed' },
  { id: '55555555-0000-4000-8000-000000000002', code: 'PO-0002', status: 'completed', lot: 'FG-NO5-L02', qc: 'pending' },
  { id: '55555555-0000-4000-8000-000000000003', code: 'PO-0003', status: 'completed', lot: 'FG-NO5-L03', qc: 'failed' },
  { id: '55555555-0000-4000-8000-000000000004', code: 'PO-0004', status: 'planned' },
  { id: '55555555-0000-4000-8000-000000000005', code: 'PO-0005', status: 'in_progress' },
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');

  // ---- warehouses ----
  await client.query(
    `insert into warehouses (id, code, name) values ($1,'WH-MAIN','Main Warehouse'), ($2,'WH-RND','R&D Warehouse')
     on conflict (id) do nothing`,
    [WAREHOUSE, WAREHOUSE_RND],
  );

  // ---- product ----
  await client.query(
    `insert into products (id, sku, name, base_unit)
     values ($1, 'FG-EDP-NO5', 'Atelier No.5 EDP', 'g'::unit_code)
     on conflict (id) do nothing`,
    [PRODUCT],
  );

  // ---- raw materials (cost updated on re-seed so value charts populate) ----
  for (const m of MATERIALS) {
    await client.query(
      `insert into raw_materials (id, sku, name, category, base_unit, density_g_per_ml, standard_cost)
       values ($1, $2, $3, $4::material_category, $5::unit_code, $6, $7)
       on conflict (id) do update set standard_cost = excluded.standard_cost`,
      [m.id, m.sku, m.name, m.category, m.unit, m.density, m.cost],
    );
  }

  // ---- formula + locked version + components ----
  await client.query(
    `insert into formulas (id, code, name, product_id) values ($1, 'F-NO5', 'Atelier No.5', $2)
     on conflict (id) do nothing`,
    [FORMULA, PRODUCT],
  );
  await client.query(
    `insert into formula_versions (id, formula_id, version_no, basis, is_locked)
     values ($1, $2, 1, 'percent'::formula_basis, true)
     on conflict (id) do nothing`,
    [FORMULA_VERSION, FORMULA],
  );
  let seq = 0;
  for (const m of MATERIALS) {
    await client.query(
      `insert into formula_components (formula_version_id, raw_material_id, quantity, unit, sequence)
       values ($1, $2, $3, $4::unit_code, $5)
       on conflict (formula_version_id, raw_material_id) do nothing`,
      [FORMULA_VERSION, m.id, m.pct, m.unit, seq++],
    );
  }

  // ---- received raw lots in WH-MAIN ----
  let i = 0;
  for (const m of MATERIALS) {
    i += 1;
    const lotId = `${LOT_PREFIX}${i}`;
    const inserted = await client.query(
      `insert into inventory_lots (id, lot_code, item_type, raw_material_id, warehouse_id, unit, status)
       values ($1, $2, 'raw', $3, $4, $5::unit_code, 'available')
       on conflict (lot_code, warehouse_id) do nothing
       returning id`,
      [lotId, `${m.sku}-L01`, m.id, WAREHOUSE, m.unit],
    );
    if (inserted.rowCount > 0) {
      await client.query(
        `select post_movement($1::uuid, 'receipt'::movement_type, $2::numeric, $3::unit_code, 'seed', null, null)`,
        [lotId, m.qty, m.unit],
      );
    }
  }

  // ---- one raw lot in the R&D warehouse (multi-warehouse stock) ----
  const berg = MATERIALS[0];
  const rndLotId = `${LOT_PREFIX}a`;
  const rndInserted = await client.query(
    `insert into inventory_lots (id, lot_code, item_type, raw_material_id, warehouse_id, unit, status)
     values ($1, 'RM-BERG-L02', 'raw', $2, $3, $4::unit_code, 'available')
     on conflict (lot_code, warehouse_id) do nothing
     returning id`,
    [rndLotId, berg.id, WAREHOUSE_RND, berg.unit],
  );
  if (rndInserted.rowCount > 0) {
    await client.query(
      `select post_movement($1::uuid, 'receipt'::movement_type, 1000::numeric, $2::unit_code, 'seed', null, null)`,
      [rndLotId, berg.unit],
    );
  }

  // ---- production runs ----
  let completedRuns = 0;
  for (const run of RUNS) {
    const startStatus = run.status === 'completed' ? 'planned' : run.status;
    const inserted = await client.query(
      `insert into production_orders (id, code, product_id, formula_version_id, warehouse_id, planned_quantity, unit, status)
       values ($1, $2, $3, $4, $5, $6, 'g'::unit_code, $7::production_status)
       on conflict (id) do nothing
       returning id`,
      [run.id, run.code, PRODUCT, FORMULA_VERSION, WAREHOUSE, BATCH_QTY, startStatus],
    );
    if (inserted.rowCount === 0) continue; // already seeded — don't re-consume stock

    if (run.status === 'completed') {
      // planned components (percent -> grams/ml in each material's unit)
      for (const m of MATERIALS) {
        await client.query(
          `insert into production_order_components (production_order_id, raw_material_id, planned_quantity, unit)
           values ($1, $2, $3, $4::unit_code)
           on conflict (production_order_id, raw_material_id) do nothing`,
          [run.id, m.id, m.pct * (BATCH_QTY / 100), m.unit],
        );
      }
      const res = await client.query(
        `select complete_production_order($1::uuid, $2, null) as lot_id`,
        [run.id, run.lot],
      );
      const finishedLotId = res.rows[0].lot_id;
      completedRuns += 1;
      // QC the finished lot: passed -> available, failed -> rejected, pending -> stays quarantine
      await client.query(
        `select record_qc($1::uuid, $2::qc_status, $3::numeric, $4::numeric, $5, null)`,
        [
          finishedLotId,
          run.qc,
          run.qc === 'pending' ? null : 0.92,
          run.qc === 'pending' ? null : 80,
          run.qc === 'failed' ? 'Off-spec: alcohol high' : run.qc === 'passed' ? 'Within spec' : 'Awaiting bench check',
        ],
      );
    }
  }

  await client.query('commit');
  console.log(
    `Seed complete — 2 warehouses, 5 raw materials (with costs), 1 locked formula,\n` +
      `6 received raw lots, ${completedRuns} completed runs (passed/pending/failed QC), +planned & in-progress orders.\n`,
  );
  console.log('Paste these into the New Production Order form:');
  console.log(`  Product ID          ${PRODUCT}`);
  console.log(`  Formula version ID  ${FORMULA_VERSION}`);
  console.log(`  Warehouse ID        ${WAREHOUSE}`);
} catch (err) {
  await client.query('rollback');
  console.error(`\nSeed failed — ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

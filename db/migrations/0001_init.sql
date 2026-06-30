-- =====================================================================
-- 0001_init.sql  — Perfume ERP: manufacturing-core schema
-- Scope: formula -> production -> QC -> inventory
-- Design notes:
--   * stock_movements is an APPEND-ONLY ledger and the source of truth.
--   * inventory_lots.quantity_on_hand is a projection, mutated only by the
--     locked post_movement() function (see 0002_functions.sql).
--   * formula_versions are immutable once locked (IP / traceability).
-- =====================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------- enums ----------
do $$ begin
  create type material_category as enum
    ('aroma_chemical','essential_oil','fixative','solvent','water','packaging');
exception when duplicate_object then null; end $$;

do $$ begin
  create type unit_code as enum ('kg','g','mg','l','ml');
exception when duplicate_object then null; end $$;

do $$ begin
  create type formula_basis as enum ('percent','mass');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lot_status as enum ('available','quarantine','expired','consumed','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type production_status as enum ('planned','in_progress','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type qc_status as enum ('pending','passed','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type movement_type as enum ('receipt','issue','production_in','adjustment');
exception when duplicate_object then null; end $$;

-- ---------- master data ----------
create table if not exists warehouses (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists raw_materials (
  id                uuid primary key default gen_random_uuid(),
  sku               text unique not null,
  name              text not null,
  category          material_category not null,
  base_unit         unit_code not null,
  density_g_per_ml  numeric(12,4),               -- enables mass<->volume conversion
  standard_cost     numeric(14,4) not null default 0,
  is_flammable      boolean not null default false,
  created_at        timestamptz not null default now()
);

create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  sku         text unique not null,
  name        text not null,
  base_unit   unit_code not null,
  created_at  timestamptz not null default now()
);

-- ---------- formulas (immutable versions) ----------
create table if not exists formulas (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  product_id  uuid references products(id),
  created_at  timestamptz not null default now()
);

create table if not exists formula_versions (
  id          uuid primary key default gen_random_uuid(),
  formula_id  uuid not null references formulas(id) on delete cascade,
  version_no  int not null,
  basis       formula_basis not null,
  is_locked   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (formula_id, version_no)
);

create table if not exists formula_components (
  id                  uuid primary key default gen_random_uuid(),
  formula_version_id  uuid not null references formula_versions(id) on delete cascade,
  raw_material_id     uuid not null references raw_materials(id),
  quantity            numeric(18,6) not null check (quantity > 0), -- percent OR mass per basis
  unit                unit_code not null,
  sequence            int not null default 0,
  unique (formula_version_id, raw_material_id)
);

-- ---------- inventory (lot tracked) ----------
create table if not exists inventory_lots (
  id                uuid primary key default gen_random_uuid(),
  lot_code          text not null,
  item_type         text not null check (item_type in ('raw','product')),
  raw_material_id   uuid references raw_materials(id),
  product_id        uuid references products(id),
  warehouse_id      uuid not null references warehouses(id),
  quantity_on_hand  numeric(18,6) not null default 0 check (quantity_on_hand >= 0),
  unit              unit_code not null,
  status            lot_status not null default 'available',
  expiry_date       date,
  received_at       timestamptz not null default now(),
  -- exactly one of raw_material_id / product_id, consistent with item_type
  constraint lot_item_xor check (
    (item_type = 'raw'     and raw_material_id is not null and product_id is null) or
    (item_type = 'product' and product_id is not null and raw_material_id is null)
  ),
  unique (lot_code, warehouse_id)
);

-- supports FEFO selection (earliest expiry first) on issuable raw lots
create index if not exists idx_lots_raw_fefo
  on inventory_lots (raw_material_id, warehouse_id, expiry_date)
  where item_type = 'raw' and status = 'available';

-- ---------- append-only ledger (source of truth) ----------
create table if not exists stock_movements (
  id              uuid primary key default gen_random_uuid(),
  lot_id          uuid not null references inventory_lots(id),
  movement_type   movement_type not null,
  quantity        numeric(18,6) not null,        -- signed: + into lot, - out of lot
  unit            unit_code not null,
  reference_type  text,
  reference_id    uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint movement_qty_nonzero check (quantity <> 0)
);
create index if not exists idx_movements_lot on stock_movements (lot_id);

-- ---------- production ----------
create table if not exists production_orders (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique not null,
  product_id          uuid not null references products(id),
  formula_version_id  uuid not null references formula_versions(id),
  warehouse_id        uuid not null references warehouses(id),
  planned_quantity    numeric(18,6) not null check (planned_quantity > 0),
  unit                unit_code not null,
  status              production_status not null default 'planned',
  output_lot_id       uuid references inventory_lots(id),
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

-- planned consumption, computed by the TS BOM engine at PO creation
create table if not exists production_order_components (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id) on delete cascade,
  raw_material_id     uuid not null references raw_materials(id),
  planned_quantity    numeric(18,6) not null check (planned_quantity > 0),
  unit                unit_code not null,
  unique (production_order_id, raw_material_id)
);

-- actual consumption (one row per lot drawn), written atomically on completion
create table if not exists production_consumptions (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id),
  lot_id              uuid not null references inventory_lots(id),
  raw_material_id     uuid not null references raw_materials(id),
  quantity            numeric(18,6) not null check (quantity > 0),
  unit                unit_code not null
);

-- ---------- QC ----------
create table if not exists qc_checks (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references inventory_lots(id),
  production_order_id uuid references production_orders(id),
  status              qc_status not null default 'pending',
  specific_gravity    numeric(8,4),
  alcohol_pct         numeric(6,3),
  notes               text,
  checked_by          uuid,
  checked_at          timestamptz
);

-- ---------- batch genealogy (forward/backward traceability) ----------
create table if not exists lot_genealogy (
  id                  uuid primary key default gen_random_uuid(),
  parent_lot_id       uuid not null references inventory_lots(id),
  child_lot_id        uuid not null references inventory_lots(id),
  production_order_id uuid not null references production_orders(id),
  quantity            numeric(18,6) not null check (quantity > 0),
  unit                unit_code not null,
  created_at          timestamptz not null default now(),
  constraint genealogy_distinct check (parent_lot_id <> child_lot_id)
);
create index if not exists idx_genealogy_parent on lot_genealogy (parent_lot_id);
create index if not exists idx_genealogy_child  on lot_genealogy (child_lot_id);

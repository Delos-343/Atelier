-- 0020_product_costing_rates.sql  (Costing — per-product rate overrides)
--
-- Deepens costing depth (0017) from a single plant-wide standard to per-product rates.
-- 0017 gave the whole plant one labor rate and one overhead rate (the costing_settings
-- singleton). In practice a hand-poured concentrate and a bottled EDT carry very different
-- labor and overhead, so a product may now record its OWN rate that overrides the
-- plant-wide default. The override is per-field: set just the labor rate and overhead
-- still inherits the plant-wide standard, or vice-versa. A product with no row (or a null
-- field) inherits — so this is purely additive and, until an override is entered, every
-- batch costs exactly as it did under 0017.
--
-- The resolution order (override field -> plant-wide -> 0) lives in ONE function,
-- effective_costing_rates(product), which the completion routine now calls instead of
-- reading costing_settings directly, and which the admin UI reads to show the effective
-- rate a product will cost at. Idempotent throughout.

-- ── per-product overrides (a row exists only when a product overrides something) ──
create table if not exists product_costing_rates (
  product_id          uuid primary key references products(id) on delete cascade,
  labor_rate_per_hour numeric(14,4) check (labor_rate_per_hour is null or labor_rate_per_hour >= 0),
  overhead_rate       numeric(6,4)  check (overhead_rate is null or overhead_rate >= 0),
  updated_at          timestamptz not null default now()
);
comment on table product_costing_rates is
  'Optional per-product overrides of the plant-wide costing_settings rates. A null field inherits the plant-wide standard.';
comment on column product_costing_rates.overhead_rate is
  'Overhead as a fraction of prime cost (material + labor); null inherits costing_settings.overhead_rate.';

alter table product_costing_rates enable row level security;
do $$
begin
  drop policy if exists product_costing_rates_select on product_costing_rates;
  create policy product_costing_rates_select on product_costing_rates for select to authenticated
    using (auth.uid() is not null);
  drop policy if exists product_costing_rates_write on product_costing_rates;
  create policy product_costing_rates_write on product_costing_rates for all to authenticated
    using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
end $$;

-- ── one place that resolves the rates a product actually costs at ─────────────
-- Per-field coalesce: product override, else plant-wide standard, else 0 (the trailing
-- 0 only matters in the impossible case the singleton row is absent). SECURITY DEFINER
-- like its costing siblings so it reads the singleton regardless of caller.
create or replace function effective_costing_rates(p_product_id uuid)
returns table(labor_rate_per_hour numeric, overhead_rate numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(pcr.labor_rate_per_hour, cs.labor_rate_per_hour, 0) as labor_rate_per_hour,
    coalesce(pcr.overhead_rate,       cs.overhead_rate,       0) as overhead_rate
  from costing_settings cs
  left join product_costing_rates pcr on pcr.product_id = p_product_id
  where cs.id = true;
$$;
revoke execute on function effective_costing_rates(uuid) from public;
grant  execute on function effective_costing_rates(uuid) to authenticated;

-- ── completion resolves rates per product (was: read costing_settings directly) ──
-- Same signature as 0017, so CREATE OR REPLACE (no DROP). Only step 3 changes: it now
-- pulls the effective rates for the order's product through effective_costing_rates,
-- centralising the override -> plant-wide -> 0 logic. Everything else — FEFO material
-- roll-up, overhead on prime cost, freezing the loaded unit_cost — is unchanged.
create or replace function complete_production_order(
  p_po_id uuid,
  p_output_lot_code text,
  p_user uuid default null,
  p_labor_hours numeric default 0
) returns uuid                     -- returns output lot id
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po production_orders%rowtype;
  v_comp record;
  v_lot record;
  v_remaining numeric;
  v_take numeric;
  v_density numeric;
  v_base_unit unit_code;
  v_std_cost numeric;
  v_line_cost numeric;
  v_material_cost numeric := 0;
  v_labor_hours numeric := coalesce(p_labor_hours, 0);
  v_labor_rate numeric;
  v_overhead_rate numeric;
  v_labor_cost numeric;
  v_overhead_cost numeric;
  v_total_cost numeric;
  v_avail_in_comp_unit numeric;
  v_output_lot_id uuid;
begin
  if v_labor_hours < 0 then
    raise exception 'labor hours cannot be negative' using errcode = 'check_violation';
  end if;

  select * into v_po from production_orders where id = p_po_id for update;
  if not found then raise exception 'production order % not found', p_po_id; end if;
  if v_po.status not in ('planned','in_progress') then
    raise exception 'production order % is % and cannot be completed', v_po.code, v_po.status
      using errcode = 'check_violation';
  end if;

  -- 1) create the finished-goods output lot in QUARANTINE (QC must release it)
  insert into inventory_lots(lot_code, item_type, product_id, warehouse_id, quantity_on_hand, unit, status)
  values (p_output_lot_code, 'product', v_po.product_id, v_po.warehouse_id, 0, v_po.unit, 'quarantine')
  returning id into v_output_lot_id;

  perform post_movement(v_output_lot_id, 'production_in', v_po.planned_quantity, v_po.unit,
                        'production_order', v_po.id, p_user);

  -- 2) consume each planned component FEFO, freezing the material cost contribution
  for v_comp in
    select * from production_order_components where production_order_id = p_po_id
  loop
    v_remaining := v_comp.planned_quantity;
    select density_g_per_ml, base_unit, standard_cost
      into v_density, v_base_unit, v_std_cost
      from raw_materials where id = v_comp.raw_material_id;

    for v_lot in
      select * from inventory_lots
       where item_type = 'raw'
         and raw_material_id = v_comp.raw_material_id
         and warehouse_id = v_po.warehouse_id
         and status = 'available'
         and quantity_on_hand > 0
         and (expiry_date is null or expiry_date >= current_date)
       order by expiry_date nulls last, received_at     -- FEFO
       for update
    loop
      exit when v_remaining <= 0;
      v_avail_in_comp_unit := convert_qty(v_lot.quantity_on_hand, v_lot.unit, v_comp.unit, v_density);
      v_take := least(v_remaining, v_avail_in_comp_unit);

      v_line_cost := convert_qty(v_take, v_comp.unit, v_base_unit, v_density) * v_std_cost;
      v_material_cost := v_material_cost + v_line_cost;

      perform post_movement(v_lot.id, 'issue', -v_take, v_comp.unit,
                            'production_order', v_po.id, p_user);
      insert into production_consumptions(production_order_id, lot_id, raw_material_id, quantity, unit, cost)
      values (p_po_id, v_lot.id, v_comp.raw_material_id, v_take, v_comp.unit, v_line_cost);
      insert into lot_genealogy(parent_lot_id, child_lot_id, production_order_id, quantity, unit)
      values (v_lot.id, v_output_lot_id, p_po_id, v_take, v_comp.unit);

      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'insufficient stock for material % on order %: short by % %',
        v_comp.raw_material_id, v_po.code, v_remaining, v_comp.unit
        using errcode = 'check_violation';
    end if;
  end loop;

  -- 3) labor + overhead from the EFFECTIVE rates for this product
  --    (per-product override -> plant-wide standard -> 0; both default 0 = material-only)
  select labor_rate_per_hour, overhead_rate
    into v_labor_rate, v_overhead_rate
    from effective_costing_rates(v_po.product_id);
  v_labor_rate := coalesce(v_labor_rate, 0);
  v_overhead_rate := coalesce(v_overhead_rate, 0);
  v_labor_cost := v_labor_hours * v_labor_rate;
  v_overhead_cost := v_overhead_rate * (v_material_cost + v_labor_cost);   -- overhead on prime cost
  v_total_cost := v_material_cost + v_labor_cost + v_overhead_cost;

  -- 4) freeze the fully-loaded unit cost onto the finished lot
  update inventory_lots
     set unit_cost = case when v_po.planned_quantity > 0 then v_total_cost / v_po.planned_quantity else 0 end
   where id = v_output_lot_id;

  update production_orders
     set status = 'completed', output_lot_id = v_output_lot_id, completed_at = now(),
         labor_hours   = v_labor_hours,
         material_cost = v_material_cost,
         labor_cost    = v_labor_cost,
         overhead_cost = v_overhead_cost
   where id = p_po_id;

  return v_output_lot_id;
end;
$$;
revoke execute on function complete_production_order(uuid, text, uuid, numeric) from public;
grant  execute on function complete_production_order(uuid, text, uuid, numeric) to authenticated;

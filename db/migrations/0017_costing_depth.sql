-- 0017_costing_depth.sql  (Costing — labor & overhead)
-- Deepens production costing from material-only to fully-loaded. A completing batch now
-- adds direct labor (entered hours × a standard rate) and factory overhead (a standard
-- rate on prime cost = material + labor) on top of the rolled-up material cost, and freezes
-- the sum as the finished lot's unit_cost. The per-component material breakdown is
-- unchanged; the three cost buckets are recorded on the order for display. Rates live in a
-- single settings row so the whole plant costs consistently; both default to 0, so costing
-- stays exactly material-only until an admin sets them (the prior behaviour, preserved).
--
-- Also promotes complete_production_order to SECURITY DEFINER. It creates the finished lot,
-- and inventory_lots has no INSERT policy (lot creation is meant to happen only inside
-- DEFINER functions, like the production output here and the returns restock). As INVOKER
-- it could only ever run under a superuser (tests) — surfacing the completion action in the
-- UI needs it to work under a real signed-in client, so it must be DEFINER like its
-- siblings. The route is gated to production/admin; direct-RPC exposure is no worse than
-- post_movement, which is already authenticated-callable.

-- ── standard cost rates (single row) ─────────────────────────────────────────
create table if not exists costing_settings (
  id                  boolean primary key default true check (id),   -- one row only
  labor_rate_per_hour numeric(14,4) not null default 0 check (labor_rate_per_hour >= 0),
  overhead_rate       numeric(6,4)  not null default 0 check (overhead_rate >= 0),
  updated_at          timestamptz not null default now()
);
insert into costing_settings (id) values (true) on conflict (id) do nothing;

comment on column costing_settings.overhead_rate is
  'Factory overhead as a fraction of prime cost (material + labor); e.g. 0.15 = 15%.';

alter table costing_settings enable row level security;
do $$
begin
  drop policy if exists costing_settings_select on costing_settings;
  create policy costing_settings_select on costing_settings for select to authenticated
    using (auth.uid() is not null);
  drop policy if exists costing_settings_write on costing_settings;
  create policy costing_settings_write on costing_settings for all to authenticated
    using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
end $$;

-- ── frozen cost buckets on the order (null until completed) ───────────────────
alter table production_orders add column if not exists labor_hours   numeric(12,4) not null default 0;
alter table production_orders add column if not exists material_cost numeric(18,6);
alter table production_orders add column if not exists labor_cost    numeric(18,6);
alter table production_orders add column if not exists overhead_cost numeric(18,6);

-- ── completion now freezes a fully-loaded unit cost ──────────────────────────
-- p_user stays the 3rd argument (existing callers pass it positionally); p_labor_hours
-- is appended 4th. Drop the old 3-arg signature first so the overload is replaced cleanly.
drop function if exists complete_production_order(uuid, text, uuid);
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

  -- 3) labor + overhead from the standard rates (both default 0 = material-only)
  select labor_rate_per_hour, overhead_rate into v_labor_rate, v_overhead_rate
    from costing_settings where id = true;
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

-- 0023_fefo_allocate.sql  (Refactor — one FEFO allocation primitive)
--
-- Behaviour-preserving refactor. Two paths consumed stock in FEFO order with the same
-- hand-written selection: the production material issue (complete_production_order) and
-- the shipment line issue (_ship_order_line). That selection — the availability filter
-- (item type, warehouse, available, on-hand>0, unexpired), the FEFO ordering, the
-- convert_qty/least allocation, and the row locking — is exactly the drift-prone part,
-- so it now lives once in fefo_allocate(...), which returns the allocation plan. Each
-- caller keeps what is genuinely its own: shipment accrues COGS from each lot's frozen
-- unit_cost; production prices at the raw material's standard cost and records
-- consumption + lot genealogy. The shortfall decision stays with the caller too
-- (shipment's greedy vs strict, production's always-strict), so the existing error
-- messages are unchanged. One deliberate tightening: the production order clause gains
-- the id tiebreaker the shipment path already had, making FEFO fully deterministic when
-- two lots share an expiry and receipt time. CREATE OR REPLACE throughout (no DROP,
-- signatures unchanged), so grants are preserved.

-- ── shared FEFO allocator: which lots, and how much from each ─────────────────
-- The one place that decides what "available to consume" means (item type, warehouse,
-- status, on-hand>0, unexpired) and the FEFO order (earliest expiry, then receipt, then
-- id for determinism), returning an allocation plan up to p_qty in the requested unit.
-- Raw materials convert by density; finished goods carry none. It LOCKS the lots it
-- returns (for update) so the caller's post_movement decrements are race-free, but it
-- does NOT move stock or raise on shortfall — each caller posts the movements, does its
-- own bookkeeping (COGS vs material cost + genealogy), and decides whether a short
-- allocation is an error. VOLATILE + SECURITY INVOKER so it runs in the caller's
-- context (as owner inside the DEFINER production path, as the signed-in user inside the
-- INVOKER shipment path), preserving today's locking and RLS exactly.
create or replace function fefo_allocate(
  p_item_type       text,
  p_raw_material_id uuid,
  p_product_id      uuid,
  p_warehouse_id    uuid,
  p_qty             numeric,
  p_unit            unit_code
) returns table(lot_id uuid, take_qty numeric, lot_unit unit_code, lot_unit_cost numeric)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_density   numeric;
  v_remaining numeric := coalesce(p_qty, 0);
  v_lot       record;
  v_avail     numeric;
  v_take      numeric;
begin
  if v_remaining <= 0 then
    return;
  end if;
  if p_item_type = 'raw' then
    select density_g_per_ml into v_density from raw_materials where id = p_raw_material_id;
  end if;

  for v_lot in
    select il.id, il.unit, il.unit_cost, il.quantity_on_hand
      from inventory_lots il
     where il.item_type = p_item_type
       and (p_raw_material_id is null or il.raw_material_id = p_raw_material_id)
       and (p_product_id     is null or il.product_id     = p_product_id)
       and il.warehouse_id = p_warehouse_id
       and il.status = 'available'
       and il.quantity_on_hand > 0
       and (il.expiry_date is null or il.expiry_date >= current_date)
     order by il.expiry_date nulls last, il.received_at, il.id   -- FEFO, deterministic
     for update
  loop
    exit when v_remaining <= 0;
    v_avail := convert_qty(v_lot.quantity_on_hand, v_lot.unit, p_unit, v_density);
    v_take  := least(v_remaining, v_avail);

    lot_id        := v_lot.id;
    take_qty      := v_take;
    lot_unit      := v_lot.unit;
    lot_unit_cost := v_lot.unit_cost;
    return next;

    v_remaining := v_remaining - v_take;
  end loop;
end;
$$;
revoke execute on function fefo_allocate(text, uuid, uuid, uuid, numeric, unit_code) from public;
grant  execute on function fefo_allocate(text, uuid, uuid, uuid, numeric, unit_code) to authenticated;

-- ── shipment line issue, re-expressed over the shared allocator ───────────────
create or replace function _ship_order_line(
  p_line_id uuid,
  p_warehouse_id uuid,
  p_target numeric,
  p_strict boolean,
  p_user uuid
) returns numeric
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_line  sales_order_lines%rowtype;
  v_alloc record;
  v_taken numeric := 0;
  v_cogs  numeric := 0;
begin
  if p_target is null or p_target <= 0 then
    return 0;
  end if;
  select * into v_line from sales_order_lines where id = p_line_id;
  if not found then
    raise exception 'sales order line % not found', p_line_id using errcode = 'no_data_found';
  end if;

  for v_alloc in
    select * from fefo_allocate('product', null, v_line.product_id,
                                p_warehouse_id, p_target, v_line.unit)
  loop
    perform post_movement(v_alloc.lot_id, 'shipment', -v_alloc.take_qty, v_line.unit,
                          'sales_order', v_line.sales_order_id, p_user);
    -- unit_cost is per lot-unit; value the take in the lot's unit
    v_cogs := v_cogs + convert_qty(v_alloc.take_qty, v_line.unit, v_alloc.lot_unit, null)
                       * coalesce(v_alloc.lot_unit_cost, 0);
    v_taken := v_taken + v_alloc.take_qty;
  end loop;

  if p_strict and v_taken < p_target then
    raise exception 'insufficient available stock for product % (short % %)',
      v_line.product_id, p_target - v_taken, v_line.unit using errcode = 'P0001';
  end if;

  if v_taken > 0 then
    update sales_order_lines
       set shipped_quantity = shipped_quantity + v_taken,
           cogs = coalesce(cogs, 0) + v_cogs
     where id = p_line_id;
  end if;

  return v_taken;
end;
$$;
revoke execute on function _ship_order_line(uuid, uuid, numeric, boolean, uuid) from public;
grant  execute on function _ship_order_line(uuid, uuid, numeric, boolean, uuid) to authenticated;

-- ── production completion, material loop re-expressed over the shared allocator ─
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
  v_alloc record;
  v_comp_taken numeric;
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

  -- 0) HALAL GATE: refuse to complete a batch whose recipe is not halal-compliant
  --    as of today. The verdict is derived from the formula version's components
  --    (v0.22); a component-free version is vacuously compliant, so orders without a
  --    recipe are unaffected. Runs before any lot or consumption work, so a blocked
  --    order is left exactly as it was.
  if not is_formula_version_halal(v_po.formula_version_id, current_date) then
    raise exception
      'production order % cannot be completed: its formula version is not halal-compliant as of % (%)',
      v_po.code,
      current_date,
      coalesce(
        (select string_agg(sku || ' — ' || reason, '; ' order by sku)
           from formula_version_halal_noncompliance(v_po.formula_version_id, current_date)),
        'no detail'
      )
      using errcode = 'check_violation';
  end if;

  -- 1) create the finished-goods output lot in QUARANTINE (QC must release it)
  v_output_lot_id := _create_lot(p_output_lot_code, 'product', null, v_po.product_id,
                                 v_po.warehouse_id, v_po.unit, 'quarantine', null);

  perform post_movement(v_output_lot_id, 'production_in', v_po.planned_quantity, v_po.unit,
                        'production_order', v_po.id, p_user);

  -- 2) consume each planned component FEFO, freezing the material cost contribution
  for v_comp in
    select * from production_order_components where production_order_id = p_po_id
  loop
    select density_g_per_ml, base_unit, standard_cost
      into v_density, v_base_unit, v_std_cost
      from raw_materials where id = v_comp.raw_material_id;

    -- FEFO allocation is centralised; this loop only prices, issues, and records lineage.
    v_comp_taken := 0;
    for v_alloc in
      select * from fefo_allocate('raw', v_comp.raw_material_id, null,
                                  v_po.warehouse_id, v_comp.planned_quantity, v_comp.unit)
    loop
      v_line_cost := convert_qty(v_alloc.take_qty, v_comp.unit, v_base_unit, v_density) * v_std_cost;
      v_material_cost := v_material_cost + v_line_cost;

      perform post_movement(v_alloc.lot_id, 'issue', -v_alloc.take_qty, v_comp.unit,
                            'production_order', v_po.id, p_user);
      insert into production_consumptions(production_order_id, lot_id, raw_material_id, quantity, unit, cost)
      values (p_po_id, v_alloc.lot_id, v_comp.raw_material_id, v_alloc.take_qty, v_comp.unit, v_line_cost);
      insert into lot_genealogy(parent_lot_id, child_lot_id, production_order_id, quantity, unit)
      values (v_alloc.lot_id, v_output_lot_id, p_po_id, v_alloc.take_qty, v_comp.unit);

      v_comp_taken := v_comp_taken + v_alloc.take_qty;
    end loop;

    if v_comp_taken < v_comp.planned_quantity then
      raise exception 'insufficient stock for material % on order %: short by % %',
        v_comp.raw_material_id, v_po.code, v_comp.planned_quantity - v_comp_taken, v_comp.unit
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

-- 0021_halal_production_gate.sql  (Halal — hard gate at production completion)
--
-- v0.22 surfaced each formula version's halal verdict for review but stopped short of
-- enforcing it ("no hard production gate yet"). This closes that loop: completing a
-- production order now REQUIRES its formula version to be halal-compliant as of the
-- completion date. Compliance is the same derived verdict as v0.22
-- (is_formula_version_halal over the version's components), so the gate can't drift
-- from what the compliance overview shows. The check runs first — before the output
-- lot, the FEFO consumption, or any cost work — so a blocked order is left untouched,
-- and the raised message names the offending materials and why. Fail-closed: materials
-- default to 'in_review', so a recipe with an unreviewed input cannot be produced until
-- it is certified.
--
-- Same signature as 0020, so CREATE OR REPLACE (no DROP). Body is identical to 0020
-- except for the new gate block; everything else — per-product effective rates, FEFO
-- roll-up, overhead on prime cost, frozen loaded unit_cost — is unchanged.

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

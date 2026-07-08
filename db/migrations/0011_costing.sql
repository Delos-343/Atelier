-- 0011_costing.sql
-- Production-order costing. When a batch completes, actual material cost is rolled
-- up from the consumptions and FROZEN: each consumption stores its cost contribution
-- (snapshot of standard_cost at completion), and the finished lot stores a unit_cost.
-- This keeps historical cost stable when a material's standard_cost later changes.
-- Also extends dashboard valuation to finished goods and makes raw valuation
-- unit-correct (converting each lot to the material's base unit before pricing).

-- ── snapshot columns ───────────────────────────────────────────────────────
alter table inventory_lots add column if not exists unit_cost numeric(18,6);
alter table production_consumptions add column if not exists cost numeric(18,6);

comment on column inventory_lots.unit_cost is
  'Per-unit cost frozen at production for finished lots (total material cost / output qty); null for raw lots, which are valued at raw_materials.standard_cost.';
comment on column production_consumptions.cost is
  'Cost contribution of this consumption, frozen at completion: convert_qty(quantity -> material base unit) * standard_cost.';

-- ── completion now rolls up and freezes cost ───────────────────────────────
create or replace function complete_production_order(
  p_po_id uuid,
  p_output_lot_code text,
  p_user uuid default null
) returns uuid                     -- returns output lot id
language plpgsql as $$
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
  v_total_cost numeric := 0;
  v_avail_in_comp_unit numeric;
  v_output_lot_id uuid;
begin
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

  -- bring produced quantity into the output lot (audited via ledger)
  perform post_movement(v_output_lot_id, 'production_in', v_po.planned_quantity, v_po.unit,
                        'production_order', v_po.id, p_user);

  -- 2) consume each planned component FEFO across available raw lots
  for v_comp in
    select * from production_order_components where production_order_id = p_po_id
  loop
    v_remaining := v_comp.planned_quantity;            -- in v_comp.unit
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
       for update                                        -- lock candidate lots
    loop
      exit when v_remaining <= 0;

      v_avail_in_comp_unit := convert_qty(v_lot.quantity_on_hand, v_lot.unit, v_comp.unit, v_density);
      v_take := least(v_remaining, v_avail_in_comp_unit);

      -- cost contribution: take (in component unit) -> material base unit * standard cost
      v_line_cost := convert_qty(v_take, v_comp.unit, v_base_unit, v_density) * v_std_cost;
      v_total_cost := v_total_cost + v_line_cost;

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

  -- 3) freeze the finished lot's unit cost (total material cost / output quantity)
  update inventory_lots
     set unit_cost = case when v_po.planned_quantity > 0 then v_total_cost / v_po.planned_quantity else 0 end
   where id = v_output_lot_id;

  update production_orders
     set status = 'completed', output_lot_id = v_output_lot_id, completed_at = now()
   where id = p_po_id;

  return v_output_lot_id;
end;
$$;

-- ── per-material cost breakdown for a production order (frozen costs) ───────
create or replace function production_order_cost(p_po_id uuid)
returns table(
  raw_material_id uuid,
  sku text,
  name text,
  consumed_quantity numeric,
  unit unit_code,
  line_cost numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    pc.raw_material_id,
    rm.sku,
    rm.name,
    sum(pc.quantity)          as consumed_quantity,
    pc.unit,
    sum(coalesce(pc.cost, 0)) as line_cost
  from production_consumptions pc
  join raw_materials rm on rm.id = pc.raw_material_id
  where pc.production_order_id = p_po_id
  group by pc.raw_material_id, rm.sku, rm.name, pc.unit
  order by line_cost desc;
$$;

revoke execute on function production_order_cost(uuid) from public;
grant  execute on function production_order_cost(uuid) to authenticated;

-- ── dashboard valuation: raw (unit-correct) + finished, split out ──────────
create or replace function dashboard_metrics()
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'inventory', json_build_object(
      'value_raw', coalesce((
        select sum(convert_qty(l.quantity_on_hand, l.unit, rm.base_unit, rm.density_g_per_ml) * rm.standard_cost)
        from inventory_lots l
        join raw_materials rm on rm.id = l.raw_material_id
        where l.item_type = 'raw'
      ), 0),
      'value_finished', coalesce((
        select sum(l.quantity_on_hand * l.unit_cost)
        from inventory_lots l
        where l.item_type = 'product' and l.unit_cost is not null
      ), 0),
      'lots_by_status', (
        select coalesce(json_object_agg(status, c), '{}'::json)
        from (select status::text, count(*) c from inventory_lots group by status) s
      ),
      'value_by_category', coalesce((
        select json_agg(row_to_json(t))
        from (
          select rm.category::text as category,
                 sum(convert_qty(l.quantity_on_hand, l.unit, rm.base_unit, rm.density_g_per_ml) * rm.standard_cost) as value
          from inventory_lots l
          join raw_materials rm on rm.id = l.raw_material_id
          where l.item_type = 'raw'
          group by rm.category
          order by value desc
        ) t
      ), '[]'::json)
    ),
    'production', json_build_object(
      'by_status', (
        select coalesce(json_object_agg(status, c), '{}'::json)
        from (select status::text, count(*) c from production_orders group by status) s
      ),
      'total', (select count(*) from production_orders)
    ),
    'qc', json_build_object(
      'passed',  (select count(*) from qc_checks where status = 'passed'),
      'failed',  (select count(*) from qc_checks where status = 'failed'),
      'pending', (select count(*) from qc_checks where status = 'pending'),
      'pass_rate', (
        select case
                 when count(*) filter (where status in ('passed', 'failed')) = 0 then null
                 else round(
                   count(*) filter (where status = 'passed')::numeric
                   / count(*) filter (where status in ('passed', 'failed')),
                   4)
               end
        from qc_checks
      )
    )
  );
$$;

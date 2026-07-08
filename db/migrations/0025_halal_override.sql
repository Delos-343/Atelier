-- 0025_halal_override.sql  (Logged admin override of the hard halal gate)
--
-- v0.24 made a non-halal-compliant recipe a HARD block at completion. This adds a narrow,
-- audited escape hatch: an administrator (and only an administrator) may complete such an
-- order by passing p_halal_override with a reason. The decision is recorded in
-- production_halal_overrides — who (auth.uid()), when, why, and a snapshot of the offending
-- inputs at the time — so the override is never silent. A non-admin, or an override without a
-- reason, still raises; and with p_halal_override left false the gate behaves exactly as before.
-- Signature changes (two new params), so the 4-arg function is dropped and recreated 6-arg.

create table if not exists production_halal_overrides (
  id                  uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references production_orders(id) on delete cascade,
  formula_version_id  uuid not null references formula_versions(id),
  reason              text not null,
  noncompliance       jsonb not null default '[]'::jsonb,   -- offending inputs at override time
  overridden_by       uuid,                                 -- auth.uid() of the admin (no FK: auth.users is GoTrue-owned)
  overridden_at       timestamptz not null default now()
);

alter table production_halal_overrides enable row level security;

-- Written ONLY inside complete_production_order (SECURITY DEFINER, owner) — so no write
-- policy exists and RLS denies any direct authenticated insert/update/delete. Readable by
-- any signed-in user for transparency of the audit trail.
drop policy if exists production_halal_overrides_select on production_halal_overrides;
create policy production_halal_overrides_select on production_halal_overrides
  for select to authenticated using (auth.uid() is not null);

grant select on production_halal_overrides to authenticated;

create index if not exists production_halal_overrides_po_idx
  on production_halal_overrides(production_order_id);

-- ── recreate the completion function with the audited override branch ─────────
drop function if exists complete_production_order(uuid, text, uuid, numeric);

create or replace function complete_production_order(
  p_po_id uuid,
  p_output_lot_code text,
  p_user uuid default null,
  p_labor_hours numeric default 0,
  p_halal_override boolean default false,
  p_override_reason text default null
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
    if not coalesce(p_halal_override, false) then
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

    -- OVERRIDE PATH: an administrator may proceed past the gate, but only with a reason,
    -- and the decision is recorded (who, when, why, and the offending inputs at the time).
    -- current_app_role()/auth.uid() reflect the CALLER even here (SECURITY DEFINER changes
    -- the privilege context, not the JWT), so the check can't be spoofed by the caller.
    if current_app_role() <> 'admin' then
      raise exception 'only an administrator may override the halal gate on order %', v_po.code
        using errcode = 'insufficient_privilege';
    end if;
    if p_override_reason is null or btrim(p_override_reason) = '' then
      raise exception 'a reason is required to override the halal gate on order %', v_po.code
        using errcode = 'check_violation';
    end if;
    insert into production_halal_overrides(
      production_order_id, formula_version_id, reason, noncompliance, overridden_by)
    values (
      p_po_id, v_po.formula_version_id, btrim(p_override_reason),
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'rawMaterialId', raw_material_id, 'sku', sku, 'name', name,
                 'halalStatus', halal_status, 'reason', reason) order by sku)
        from formula_version_halal_noncompliance(v_po.formula_version_id, current_date)), '[]'::jsonb),
      auth.uid());
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
revoke execute on function complete_production_order(uuid, text, uuid, numeric, boolean, text) from public;
grant  execute on function complete_production_order(uuid, text, uuid, numeric, boolean, text) to authenticated;

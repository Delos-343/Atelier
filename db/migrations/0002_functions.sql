-- =====================================================================
-- 0002_functions.sql — integrity core
--   convert_qty             : unit conversion (mass<->volume via density)
--   post_movement           : the ONLY way stock changes; locks the lot row,
--                             refuses negative stock + expired/quarantined issue
--   complete_production_order: atomic consume(FEFO)+produce+genealogy
--   record_qc               : QC result; pass releases lot, fail rejects it
-- =====================================================================

-- ---------- unit conversion ----------
create or replace function convert_qty(
  p_qty numeric, p_from unit_code, p_to unit_code, p_density_g_per_ml numeric default null
) returns numeric
language plpgsql immutable as $$
declare
  v_grams numeric;
  v_ml    numeric;
  from_is_mass boolean := p_from in ('kg','g','mg');
  to_is_mass   boolean := p_to   in ('kg','g','mg');
begin
  if p_from = p_to then return p_qty; end if;

  if from_is_mass then
    v_grams := case p_from when 'kg' then p_qty*1000 when 'g' then p_qty when 'mg' then p_qty/1000 end;
  else
    v_ml := case p_from when 'l' then p_qty*1000 when 'ml' then p_qty end;
  end if;

  if from_is_mass <> to_is_mass then
    if p_density_g_per_ml is null or p_density_g_per_ml <= 0 then
      raise exception 'density required to convert between mass and volume (% -> %)', p_from, p_to;
    end if;
    if from_is_mass then v_ml := v_grams / p_density_g_per_ml;
    else                 v_grams := v_ml * p_density_g_per_ml;
    end if;
  end if;

  if to_is_mass then
    return case p_to when 'kg' then v_grams/1000 when 'g' then v_grams when 'mg' then v_grams*1000 end;
  else
    return case p_to when 'l' then v_ml/1000 when 'ml' then v_ml end;
  end if;
end;
$$;

-- ---------- post a stock movement (locked, no-negative primitive) ----------
create or replace function post_movement(
  p_lot_id uuid,
  p_type movement_type,
  p_qty_signed numeric,            -- + into lot, - out of lot (in p_unit)
  p_unit unit_code,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_user uuid default null
) returns uuid
language plpgsql as $$
declare
  v_lot inventory_lots%rowtype;
  v_density numeric;
  v_delta numeric;                 -- signed qty converted to lot.unit
  v_new_on_hand numeric;
  v_movement_id uuid;
begin
  -- lock the lot row: serializes ALL concurrent movements on this lot
  select * into v_lot from inventory_lots where id = p_lot_id for update;
  if not found then
    raise exception 'lot % not found', p_lot_id using errcode = 'no_data_found';
  end if;

  if v_lot.raw_material_id is not null then
    select density_g_per_ml into v_density from raw_materials where id = v_lot.raw_material_id;
  end if;

  v_delta := convert_qty(p_qty_signed, p_unit, v_lot.unit, v_density);

  -- issue-side guards
  if v_delta < 0 then
    if v_lot.status <> 'available' then
      raise exception 'cannot issue from lot % with status %', v_lot.lot_code, v_lot.status
        using errcode = 'check_violation';
    end if;
    if v_lot.expiry_date is not null and v_lot.expiry_date < current_date then
      raise exception 'cannot issue from expired lot % (expired %)', v_lot.lot_code, v_lot.expiry_date
        using errcode = 'check_violation';
    end if;
  end if;

  v_new_on_hand := v_lot.quantity_on_hand + v_delta;
  if v_new_on_hand < 0 then
    raise exception 'insufficient stock in lot %: on_hand=%, requested=%',
      v_lot.lot_code, v_lot.quantity_on_hand, abs(v_delta)
      using errcode = 'check_violation';
  end if;

  insert into stock_movements(lot_id, movement_type, quantity, unit, reference_type, reference_id, created_by)
  values (p_lot_id, p_type, v_delta, v_lot.unit, p_reference_type, p_reference_id, p_user)
  returning id into v_movement_id;

  update inventory_lots
     set quantity_on_hand = v_new_on_hand,
         status = case when v_new_on_hand = 0 and v_delta < 0 then 'consumed' else status end
   where id = p_lot_id;

  return v_movement_id;
end;
$$;

-- ---------- complete a production order (atomic) ----------
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
    select density_g_per_ml into v_density from raw_materials where id = v_comp.raw_material_id;

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

      perform post_movement(v_lot.id, 'issue', -v_take, v_comp.unit,
                            'production_order', v_po.id, p_user);

      insert into production_consumptions(production_order_id, lot_id, raw_material_id, quantity, unit)
      values (p_po_id, v_lot.id, v_comp.raw_material_id, v_take, v_comp.unit);

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

  update production_orders
     set status = 'completed', output_lot_id = v_output_lot_id, completed_at = now()
   where id = p_po_id;

  return v_output_lot_id;
end;
$$;

-- ---------- record a QC result ----------
create or replace function record_qc(
  p_lot_id uuid, p_status qc_status, p_sg numeric default null,
  p_alcohol numeric default null, p_notes text default null, p_user uuid default null
) returns void
language plpgsql as $$
declare v_lot inventory_lots%rowtype;
begin
  select * into v_lot from inventory_lots where id = p_lot_id for update;
  if not found then raise exception 'lot % not found', p_lot_id; end if;

  insert into qc_checks(lot_id, status, specific_gravity, alcohol_pct, notes, checked_by, checked_at)
  values (p_lot_id, p_status, p_sg, p_alcohol, p_notes, p_user, now());

  if p_status = 'passed' then
    update inventory_lots set status='available' where id=p_lot_id and status='quarantine';
  elsif p_status = 'failed' then
    update inventory_lots set status='rejected' where id=p_lot_id;
  end if;
end;
$$;

-- 0015_deliberate_shipment.sql  (Phase 2b cont. — deliberate per-line split quantities)
-- Adds an explicit "ship exactly these quantities per line" path alongside the greedy
-- "ship everything available" one, for allocating scarce stock deliberately across orders.
-- Both now share one FEFO issue primitive (_ship_order_line); the greedy and deliberate
-- entry points differ only in how each line's target quantity is chosen and whether a
-- shortfall raises. The order-status recompute is shared logic, inlined in both (kept out
-- of a standalone function so it can't be called to wrongly flip a draft order's status).

-- ── shared primitive: issue up to p_target of one line FEFO, accruing COGS ────
-- Returns the quantity actually shipped (in the line's unit). p_strict=true raises
-- when the full target can't be met (deliberate request); false ships what it can
-- (greedy). SECURITY INVOKER: the sales_order_lines write is admin-RLS gated (a
-- non-admin's trailing update fails and rolls back every post_movement in the call),
-- while the ledger rows are written by the SECURITY DEFINER post_movement.
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
  v_line sales_order_lines%rowtype;
  v_lot record;
  v_remaining numeric;          -- of the target, in the line's unit
  v_take numeric;
  v_taken numeric := 0;
  v_cogs numeric := 0;
  v_avail_in_line_unit numeric;
begin
  if p_target is null or p_target <= 0 then
    return 0;
  end if;
  select * into v_line from sales_order_lines where id = p_line_id;
  if not found then
    raise exception 'sales order line % not found', p_line_id using errcode = 'no_data_found';
  end if;

  v_remaining := p_target;

  for v_lot in
    select * from inventory_lots
     where item_type = 'product'
       and product_id = v_line.product_id
       and warehouse_id = p_warehouse_id
       and status = 'available'
       and quantity_on_hand > 0
       and (expiry_date is null or expiry_date >= current_date)
     order by expiry_date nulls last, received_at, id    -- FEFO
     for update
  loop
    exit when v_remaining <= 0;

    -- finished goods carry no density: identity for the same unit, scales within a
    -- dimension (l<->ml), convert_qty raises across mass<->volume (correct).
    v_avail_in_line_unit := convert_qty(v_lot.quantity_on_hand, v_lot.unit, v_line.unit, null);
    v_take := least(v_remaining, v_avail_in_line_unit);

    perform post_movement(v_lot.id, 'shipment', -v_take, v_line.unit,
                          'sales_order', v_line.sales_order_id, p_user);

    v_cogs := v_cogs + convert_qty(v_take, v_line.unit, v_lot.unit, null) * coalesce(v_lot.unit_cost, 0);
    v_taken := v_taken + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  if p_strict and v_remaining > 0 then
    raise exception 'insufficient available stock for product % (short % %)',
      v_line.product_id, v_remaining, v_line.unit using errcode = 'P0001';
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

-- ── greedy: ship everything available now (re-expressed over the primitive) ──
create or replace function ship_sales_order(p_order_id uuid, p_user uuid default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order sales_orders%rowtype;
  v_line record;
  v_total_taken numeric := 0;
begin
  select * into v_order from sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'sales order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_order.status not in ('confirmed', 'partially_shipped') then
    raise exception 'sales order % is % and cannot be shipped (must be confirmed or partially shipped)',
      v_order.code, v_order.status;
  end if;

  for v_line in
    select id, quantity, shipped_quantity from sales_order_lines where sales_order_id = p_order_id
  loop
    v_total_taken := v_total_taken
      + _ship_order_line(v_line.id, v_order.warehouse_id,
                         v_line.quantity - v_line.shipped_quantity, false, p_user);
  end loop;

  if v_total_taken = 0 then
    raise exception 'no available stock to ship for any line on order %', v_order.code;
  end if;

  update sales_orders set status = (
    case when not exists (
      select 1 from sales_order_lines
       where sales_order_id = p_order_id and shipped_quantity < quantity)
    then 'shipped' else 'partially_shipped' end)::sales_order_status
  where id = p_order_id;
end;
$$;

-- ── deliberate: ship exactly the requested quantity per line ─────────────────
-- p_lines = [{ "line_id": uuid, "quantity": number }, ...]. Quantities of 0 (or
-- omitted lines) are skipped; a request beyond a line's outstanding or beyond
-- available stock raises (and rolls back), so a deliberate split never silently
-- ships less than asked.
create or replace function ship_sales_order_lines(
  p_order_id uuid,
  p_lines jsonb,
  p_user uuid default null
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order sales_orders%rowtype;
  v_req record;
  v_line sales_order_lines%rowtype;
  v_outstanding numeric;
  v_total_requested numeric := 0;
begin
  select * into v_order from sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'sales order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_order.status not in ('confirmed', 'partially_shipped') then
    raise exception 'sales order % is % and cannot be shipped (must be confirmed or partially shipped)',
      v_order.code, v_order.status;
  end if;

  for v_req in
    select (e->>'line_id')::uuid as line_id, (e->>'quantity')::numeric as quantity
    from jsonb_array_elements(p_lines) e
  loop
    if v_req.quantity is null or v_req.quantity <= 0 then
      continue;  -- 0 / omitted means "don't ship this line in this dispatch"
    end if;

    select * into v_line from sales_order_lines
     where id = v_req.line_id and sales_order_id = p_order_id;
    if not found then
      raise exception 'line % does not belong to order %', v_req.line_id, v_order.code
        using errcode = 'P0001';
    end if;

    v_outstanding := v_line.quantity - v_line.shipped_quantity;
    if v_req.quantity > v_outstanding then
      raise exception 'cannot ship % of product %; only % outstanding on the line',
        v_req.quantity, v_line.product_id, v_outstanding using errcode = 'P0001';
    end if;

    v_total_requested := v_total_requested + v_req.quantity;
    -- strict: must ship the full requested amount or raise (insufficient stock)
    perform _ship_order_line(v_line.id, v_order.warehouse_id, v_req.quantity, true, p_user);
  end loop;

  if v_total_requested = 0 then
    raise exception 'no quantities specified to ship on order %', v_order.code
      using errcode = 'P0001';
  end if;

  update sales_orders set status = (
    case when not exists (
      select 1 from sales_order_lines
       where sales_order_id = p_order_id and shipped_quantity < quantity)
    then 'shipped' else 'partially_shipped' end)::sales_order_status
  where id = p_order_id;
end;
$$;
revoke execute on function ship_sales_order_lines(uuid, jsonb, uuid) from public;
grant  execute on function ship_sales_order_lines(uuid, jsonb, uuid) to authenticated;

-- ── read model: surface available finished stock per line ────────────────────
-- (drop-first: return signature changes again.) available_quantity sums available,
-- non-expired finished lots of the line's product IN THE LINE'S UNIT in the order's
-- warehouse — the ceiling the deliberate-ship form caps each input at. Same-unit sum
-- keeps the read conversion-free (finished goods are produced in the product's unit).
drop function if exists sales_order_lines_costed(uuid);
create function sales_order_lines_costed(p_order_id uuid)
returns table(
  line_id uuid,
  product_id uuid,
  sku text,
  name text,
  quantity numeric,
  unit unit_code,
  unit_price numeric,
  est_unit_cost numeric,
  line_revenue numeric,
  expected_margin numeric,
  shipped_quantity numeric,
  cogs numeric,
  realized_margin numeric,
  available_quantity numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    sol.id as line_id,
    sol.product_id,
    p.sku,
    p.name,
    sol.quantity,
    sol.unit,
    sol.unit_price,
    c.est_unit_cost,
    sol.unit_price * sol.quantity as line_revenue,
    case when c.est_unit_cost is null then null
         else (sol.unit_price - c.est_unit_cost) * sol.quantity end as expected_margin,
    sol.shipped_quantity,
    sol.cogs,
    case when sol.cogs is null then null
         else sol.unit_price * sol.shipped_quantity - sol.cogs end as realized_margin,
    av.available_quantity
  from sales_order_lines sol
  join products p on p.id = sol.product_id
  join sales_orders so on so.id = sol.sales_order_id
  left join lateral (select product_available_cost(sol.product_id) as est_unit_cost) c on true
  left join lateral (
    select coalesce(sum(il.quantity_on_hand), 0) as available_quantity
    from inventory_lots il
    where il.item_type = 'product'
      and il.product_id = sol.product_id
      and il.warehouse_id = so.warehouse_id
      and il.unit = sol.unit
      and il.status = 'available'
      and il.quantity_on_hand > 0
      and (il.expiry_date is null or il.expiry_date >= current_date)
  ) av on true
  where sol.sales_order_id = p_order_id
  order by p.sku;
$$;
revoke execute on function sales_order_lines_costed(uuid) from public;
grant  execute on function sales_order_lines_costed(uuid) to authenticated;

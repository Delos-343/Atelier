-- 0013_shipment.sql  (Phase 2b — shipment + realized COGS)
-- Shipping a confirmed sales order issues its finished lots FEFO out of stock and
-- freezes realized COGS onto the order lines, so realized margin = revenue − COGS.
-- Reuses post_movement's issue-side guard, which only draws 'available' lots — i.e.
-- a shipment can never pull quarantined or QC-failed stock.

-- ── new movement type ───────────────────────────────────────────────────────
-- (idempotent; ADD VALUE is not used within this migration, only referenced by a
--  deferred plpgsql body, so it is transaction-safe.)
alter type movement_type add value if not exists 'shipment';

-- ── realized fields frozen at shipment (mirrors production_consumptions.cost) ─
alter table sales_order_lines
  add column if not exists shipped_quantity numeric(18,6) not null default 0;
alter table sales_order_lines
  add column if not exists cogs numeric(18,6);  -- realized COGS, null until shipped

-- ── extend the line read model with realized COGS / margin ───────────────────
-- (return signature changes, so drop first; re-grant afterwards.) Expected fields
-- stay for the pre-shipment preview; realized fields are null until shipped.
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
  realized_margin numeric
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
         else sol.unit_price * sol.shipped_quantity - sol.cogs end as realized_margin
  from sales_order_lines sol
  join products p on p.id = sol.product_id
  left join lateral (select product_available_cost(sol.product_id) as est_unit_cost) c on true
  where sol.sales_order_id = p_order_id
  order by p.sku;
$$;
revoke execute on function sales_order_lines_costed(uuid) from public;
grant  execute on function sales_order_lines_costed(uuid) to authenticated;

-- ── ship a confirmed order (atomic) ─────────────────────────────────────────
-- SECURITY INVOKER: the admin-write RLS on sales_orders/sales_order_lines is the
-- gate (a non-admin's line update fails and rolls the whole shipment back), while
-- the ledger itself is written by post_movement (SECURITY DEFINER). The API route
-- also requires admin. Improves on the production path by surfacing 4xx, not 500.
create or replace function ship_sales_order(
  p_order_id uuid,
  p_user uuid default null
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order sales_orders%rowtype;
  v_line record;
  v_lot record;
  v_remaining numeric;          -- in v_line.unit
  v_take numeric;               -- in v_line.unit
  v_avail_in_line_unit numeric; -- lot on-hand expressed in v_line.unit
  v_line_cogs numeric;
begin
  select * into v_order from sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'sales order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_order.status <> 'confirmed' then
    raise exception 'sales order % is % and cannot be shipped (must be confirmed)',
      v_order.code, v_order.status;
  end if;

  for v_line in
    select * from sales_order_lines where sales_order_id = p_order_id
  loop
    v_remaining := v_line.quantity;       -- in v_line.unit
    v_line_cogs := 0;

    for v_lot in
      select * from inventory_lots
       where item_type = 'product'
         and product_id = v_line.product_id
         and warehouse_id = v_order.warehouse_id
         and status = 'available'
         and quantity_on_hand > 0
         and (expiry_date is null or expiry_date >= current_date)
       order by expiry_date nulls last, received_at      -- FEFO
       for update                                         -- lock candidate lots
    loop
      exit when v_remaining <= 0;

      -- finished goods carry no density: identity for the same unit, scales within
      -- a dimension (l<->ml), and convert_qty raises across mass<->volume (correct).
      v_avail_in_line_unit := convert_qty(v_lot.quantity_on_hand, v_lot.unit, v_line.unit, null);
      v_take := least(v_remaining, v_avail_in_line_unit);                 -- in v_line.unit

      perform post_movement(v_lot.id, 'shipment', -v_take, v_line.unit,
                            'sales_order', p_order_id, p_user);

      -- realized COGS: take (line unit) -> lot unit * that lot's frozen unit_cost
      v_line_cogs := v_line_cogs
        + convert_qty(v_take, v_line.unit, v_lot.unit, null) * coalesce(v_lot.unit_cost, 0);

      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      raise exception 'insufficient available stock for product % on order %: short by % %',
        v_line.product_id, v_order.code, v_remaining, v_line.unit;
    end if;

    update sales_order_lines
       set shipped_quantity = v_line.quantity,
           cogs = v_line_cogs
     where id = v_line.id;
  end loop;

  update sales_orders set status = 'shipped' where id = p_order_id;
end;
$$;
revoke execute on function ship_sales_order(uuid, uuid) from public;
grant  execute on function ship_sales_order(uuid, uuid) to authenticated;

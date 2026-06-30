-- 0014_partial_shipment.sql  (Phase 2b cont. — partial / multi-shipment)
-- Relaxes ship_sales_order from all-or-nothing to "ship what's available now",
-- callable repeatedly. Each call issues min(outstanding, on-hand) FEFO per line,
-- ACCUMULATES shipped_quantity + cogs, and lands the order on 'shipped' when every
-- line is fully dispatched or 'partially_shipped' while any remainder is on backorder.
-- The stock_movements ledger (already keyed by sales_order) is the per-dispatch history.

-- ── new terminal-ish status for a backordered order ──────────────────────────
-- ADD VALUE is only referenced at runtime by the function below (deferred body),
-- never used in this migration's own transaction, so this is safe on PG 12+.
alter type sales_order_status add value if not exists 'partially_shipped';

-- ── ship available stock now; backorder the rest (atomic per call) ───────────
-- Still SECURITY INVOKER: admin-write RLS on the order tables is the gate (a
-- non-admin's accumulate update fails and rolls the dispatch back), the ledger is
-- written by the SECURITY DEFINER post_movement, and the API route requires admin.
-- Raises only when NOTHING across the order could ship (so the caller gets feedback
-- instead of a silent no-op); a genuine shortfall ships what it can and backorders.
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
  v_outstanding numeric;        -- qty - already shipped, in v_line.unit
  v_avail_in_line_unit numeric; -- lot on-hand expressed in v_line.unit
  v_take numeric;               -- taken from one lot, in v_line.unit
  v_line_taken numeric;         -- total taken for this line, this call
  v_line_cogs numeric;          -- COGS accrued for this line, this call
  v_total_taken numeric := 0;   -- across all lines, this call
  v_all_done boolean := true;   -- every line fully shipped after this call?
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
    select * from sales_order_lines where sales_order_id = p_order_id
  loop
    v_outstanding := v_line.quantity - v_line.shipped_quantity;
    if v_outstanding <= 0 then
      continue;  -- this line is already fully dispatched
    end if;

    v_line_taken := 0;
    v_line_cogs := 0;

    -- FEFO across this product's available finished lots in the order's warehouse
    for v_lot in
      select * from inventory_lots
       where item_type = 'product'
         and product_id = v_line.product_id
         and warehouse_id = v_order.warehouse_id
         and status = 'available'
         and quantity_on_hand > 0
         and (expiry_date is null or expiry_date >= current_date)
       order by expiry_date nulls last, received_at, id
       for update
    loop
      exit when v_outstanding <= 0;

      -- finished goods carry no density: identity for the same unit, scales within
      -- a dimension (l<->ml), convert_qty raises across mass<->volume (correct).
      v_avail_in_line_unit := convert_qty(v_lot.quantity_on_hand, v_lot.unit, v_line.unit, null);
      v_take := least(v_outstanding, v_avail_in_line_unit);

      perform post_movement(v_lot.id, 'shipment', -v_take, v_line.unit,
                            'sales_order', p_order_id, p_user);

      v_line_cogs := v_line_cogs
        + convert_qty(v_take, v_line.unit, v_lot.unit, null) * coalesce(v_lot.unit_cost, 0);
      v_line_taken := v_line_taken + v_take;
      v_outstanding := v_outstanding - v_take;
    end loop;

    if v_line_taken > 0 then
      update sales_order_lines
         set shipped_quantity = shipped_quantity + v_line_taken,
             cogs = coalesce(cogs, 0) + v_line_cogs
       where id = v_line.id;
      v_total_taken := v_total_taken + v_line_taken;
    end if;

    if v_outstanding > 0 then
      v_all_done := false;  -- remainder stays on backorder
    end if;
  end loop;

  if v_total_taken = 0 then
    raise exception 'no available stock to ship for any line on order %', v_order.code;
  end if;

  update sales_orders
     set status = (case when v_all_done then 'shipped' else 'partially_shipped' end)::sales_order_status
   where id = p_order_id;
end;
$$;
revoke execute on function ship_sales_order(uuid, uuid) from public;
grant  execute on function ship_sales_order(uuid, uuid) to authenticated;

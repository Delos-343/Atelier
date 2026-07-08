-- 0019_available_quantity_fn.sql
--
-- Refactor (behaviour-preserving): extract the "available finished-goods quantity
-- of a product, in a warehouse, in a given unit" aggregate into a named function.
--
-- This exact lateral had been retyped inside every successive revision of
-- sales_order_lines_costed (0012 -> 0015 -> 0016), which is drift-prone: the
-- status/expiry/on-hand predicates that define "available" lived in more than one
-- place. It now has a single home and a name, mirroring its sibling
-- product_available_cost(uuid) from 0012. Same security posture (SQL, STABLE,
-- SECURITY DEFINER over inventory_lots) so the figure is identical to the inline
-- version it replaces, and it is reusable by future callers (shipment preview,
-- dashboards, the per-product costing screens).
--
-- Idempotent: CREATE OR REPLACE throughout; the costed function keeps the exact
-- same signature and return columns, so no DROP is needed.

create or replace function product_available_quantity(
  p_product_id   uuid,
  p_warehouse_id uuid,
  p_unit         unit_code
) returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(il.quantity_on_hand), 0)
  from inventory_lots il
  where il.item_type = 'product'
    and il.product_id = p_product_id
    and il.warehouse_id = p_warehouse_id
    and il.unit = p_unit
    and il.status = 'available'
    and il.quantity_on_hand > 0
    and (il.expiry_date is null or il.expiry_date >= current_date);
$$;
revoke execute on function product_available_quantity(uuid, uuid, unit_code) from public;
grant  execute on function product_available_quantity(uuid, uuid, unit_code) to authenticated;

-- Re-point the costed line view at the new helper. Body is otherwise identical to
-- the 0016 definition; only the inline `av` lateral is replaced by a scalar call.
create or replace function sales_order_lines_costed(p_order_id uuid)
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
  available_quantity numeric,
  returned_quantity numeric
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
         else sol.unit_price * (sol.shipped_quantity - sol.returned_quantity) - sol.cogs
    end as realized_margin,
    product_available_quantity(sol.product_id, so.warehouse_id, sol.unit) as available_quantity,
    sol.returned_quantity
  from sales_order_lines sol
  join products p on p.id = sol.product_id
  join sales_orders so on so.id = sol.sales_order_id
  left join lateral (select product_available_cost(sol.product_id) as est_unit_cost) c on true
  where sol.sales_order_id = p_order_id
  order by p.sku;
$$;
revoke execute on function sales_order_lines_costed(uuid) from public;
grant  execute on function sales_order_lines_costed(uuid) to authenticated;

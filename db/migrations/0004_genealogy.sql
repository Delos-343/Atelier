-- =====================================================================
-- 0004_genealogy.sql — traceability traversal
--   trace_lot_ancestors(lot)   : every lot that fed into this lot (backward recall)
--   trace_lot_descendants(lot)  : every lot this lot ended up in (forward recall)
-- SECURITY INVOKER: respects RLS (genealogy/lots are SELECT-able by authenticated).
-- =====================================================================

create or replace function trace_lot_ancestors(p_lot_id uuid)
returns table (lot_id uuid, lot_code text, depth int, via_order uuid, quantity numeric, unit unit_code)
language sql stable as $$
  with recursive chain as (
    select g.parent_lot_id as lot_id, 1 as depth, g.production_order_id as via_order, g.quantity, g.unit
      from lot_genealogy g
     where g.child_lot_id = p_lot_id
    union all
    select g.parent_lot_id, c.depth + 1, g.production_order_id, g.quantity, g.unit
      from lot_genealogy g
      join chain c on g.child_lot_id = c.lot_id
  )
  select c.lot_id, il.lot_code, c.depth, c.via_order, c.quantity, c.unit
    from chain c
    join inventory_lots il on il.id = c.lot_id
   order by c.depth, il.lot_code;
$$;

create or replace function trace_lot_descendants(p_lot_id uuid)
returns table (lot_id uuid, lot_code text, depth int, via_order uuid, quantity numeric, unit unit_code)
language sql stable as $$
  with recursive chain as (
    select g.child_lot_id as lot_id, 1 as depth, g.production_order_id as via_order, g.quantity, g.unit
      from lot_genealogy g
     where g.parent_lot_id = p_lot_id
    union all
    select g.child_lot_id, c.depth + 1, g.production_order_id, g.quantity, g.unit
      from lot_genealogy g
      join chain c on g.parent_lot_id = c.lot_id
  )
  select c.lot_id, il.lot_code, c.depth, c.via_order, c.quantity, c.unit
    from chain c
    join inventory_lots il on il.id = c.lot_id
   order by c.depth, il.lot_code;
$$;

grant execute on function trace_lot_ancestors(uuid) to authenticated;
grant execute on function trace_lot_descendants(uuid) to authenticated;

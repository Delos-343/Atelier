-- 0016_returns.sql  (Distribution — returns / credit notes)
-- The inverse of shipment: take shipped goods back into inventory as a new available
-- lot at the blended realized cost, reverse that COGS off the line, and record a credit
-- note. Returns do NOT change the order's fulfilment status (the order was still shipped);
-- they accrue returned_quantity + reduce realized COGS, tracked alongside the credit note.
-- COGS reversal uses the line's blended per-unit realized cost (cogs / net-out), the only
-- defensible rate when a shipment drew across lots — mirroring how shipment froze it.

-- ── new movement type: return (re-entry into stock) ──────────────────────────
-- Referenced only at runtime by the functions below, never in this transaction.
alter type movement_type add value if not exists 'return';

-- ── cumulative returned quantity per line ────────────────────────────────────
alter table sales_order_lines add column if not exists returned_quantity numeric(18,6) not null default 0;

-- ── credit note documents ────────────────────────────────────────────────────
create table if not exists credit_notes (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,
  sales_order_id uuid not null references sales_orders(id),
  credit_date    date not null default current_date,
  created_at     timestamptz not null default now()
);

create table if not exists credit_note_lines (
  id                  uuid primary key default gen_random_uuid(),
  credit_note_id      uuid not null references credit_notes(id) on delete cascade,
  sales_order_line_id uuid not null references sales_order_lines(id),
  product_id          uuid not null references products(id),
  quantity            numeric(18,6) not null check (quantity > 0),
  unit                unit_code not null,
  unit_price          numeric(14,4) not null default 0 check (unit_price >= 0),
  cogs_reversed       numeric(18,6) not null default 0
);
create index if not exists idx_cnl_note on credit_note_lines(credit_note_id);
create index if not exists idx_cn_order on credit_notes(sales_order_id);

-- ── RLS: read for any authenticated, write admin-only (mirrors sales tables) ──
alter table credit_notes      enable row level security;
alter table credit_note_lines enable row level security;
do $$
declare t text;
begin
  foreach t in array array['credit_notes','credit_note_lines'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (auth.uid() is not null);$f$, t);
    execute format('drop policy if exists %1$s_write on %1$I;', t);
    execute format($f$create policy %1$s_write on %1$I for all to authenticated
                       using (current_app_role() = 'admin')
                       with check (current_app_role() = 'admin');$f$, t);
  end loop;
end $$;

-- ── DEFINER primitive: re-enter returned goods as a new available lot ────────
-- Lot creation requires DEFINER (no admin INSERT policy on inventory_lots; same as
-- production output). No worse than post_movement, which is already authenticated-
-- callable. The financial writes stay in the INVOKER orchestrator below.
create or replace function _restock_returned_lot(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_lot_code text,
  p_qty numeric,
  p_unit unit_code,
  p_unit_cost numeric,
  p_credit_note_id uuid,
  p_user uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot_id uuid;
begin
  insert into inventory_lots(lot_code, item_type, product_id, warehouse_id,
                             quantity_on_hand, unit, status, unit_cost, received_at)
  values (p_lot_code, 'product', p_product_id, p_warehouse_id, 0, p_unit, 'available', p_unit_cost, now())
  returning id into v_lot_id;

  perform post_movement(v_lot_id, 'return', p_qty, p_unit, 'credit_note', p_credit_note_id, p_user);
  return v_lot_id;
end;
$$;
revoke execute on function _restock_returned_lot(uuid, uuid, text, numeric, unit_code, numeric, uuid, uuid) from public;
grant  execute on function _restock_returned_lot(uuid, uuid, text, numeric, unit_code, numeric, uuid, uuid) to authenticated;

-- ── orchestrator: process a return and issue a credit note ───────────────────
-- p_lines = [{ "line_id": uuid, "quantity": number }, ...]. Per line, quantity must
-- be <= what's still out with the customer (shipped - returned). SECURITY INVOKER: the
-- credit_notes / credit_note_lines / sales_order_lines writes are admin-RLS gated (a
-- non-admin's first insert fails and rolls back the whole return), while the stock
-- re-entry goes through the DEFINER helper. The API route also requires admin.
create or replace function create_return(
  p_order_id uuid,
  p_code text,
  p_lines jsonb,
  p_user uuid default null
) returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order sales_orders%rowtype;
  v_cn_id uuid;
  v_req record;
  v_line sales_order_lines%rowtype;
  v_net_out numeric;
  v_per_unit_cogs numeric;
  v_reversed numeric;
  v_total_qty numeric := 0;
begin
  select * into v_order from sales_orders where id = p_order_id for update;
  if not found then
    raise exception 'sales order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_order.status not in ('shipped', 'partially_shipped') then
    raise exception 'sales order % has no shipped goods to return (status: %)',
      v_order.code, v_order.status using errcode = 'P0001';
  end if;

  insert into credit_notes(code, sales_order_id, credit_date)
  values (p_code, p_order_id, current_date)
  returning id into v_cn_id;

  for v_req in
    select (e->>'line_id')::uuid as line_id, (e->>'quantity')::numeric as quantity
    from jsonb_array_elements(p_lines) e
  loop
    if v_req.quantity is null or v_req.quantity <= 0 then
      continue;  -- 0 / omitted means "nothing returned on this line"
    end if;

    select * into v_line from sales_order_lines
     where id = v_req.line_id and sales_order_id = p_order_id;
    if not found then
      raise exception 'line % does not belong to order %', v_req.line_id, v_order.code
        using errcode = 'P0001';
    end if;

    v_net_out := v_line.shipped_quantity - v_line.returned_quantity;
    if v_req.quantity > v_net_out then
      raise exception 'cannot return % of product %; only % still out with the customer',
        v_req.quantity, v_line.product_id, v_net_out using errcode = 'P0001';
    end if;

    -- blended per-unit realized COGS of the goods still out
    v_per_unit_cogs := case when v_net_out > 0 then coalesce(v_line.cogs, 0) / v_net_out else 0 end;
    v_reversed := v_req.quantity * v_per_unit_cogs;

    perform _restock_returned_lot(
      v_line.product_id, v_order.warehouse_id,
      p_code || '-' || left(v_line.id::text, 8),
      v_req.quantity, v_line.unit, v_per_unit_cogs, v_cn_id, p_user);

    update sales_order_lines
       set returned_quantity = returned_quantity + v_req.quantity,
           cogs = coalesce(cogs, 0) - v_reversed
     where id = v_line.id;

    insert into credit_note_lines(
      credit_note_id, sales_order_line_id, product_id, quantity, unit, unit_price, cogs_reversed)
    values (v_cn_id, v_line.id, v_line.product_id, v_req.quantity, v_line.unit, v_line.unit_price, v_reversed);

    v_total_qty := v_total_qty + v_req.quantity;
  end loop;

  if v_total_qty = 0 then
    raise exception 'no quantities specified to return on order %', v_order.code using errcode = 'P0001';
  end if;

  return v_cn_id;
end;
$$;
revoke execute on function create_return(uuid, text, jsonb, uuid) from public;
grant  execute on function create_return(uuid, text, jsonb, uuid) to authenticated;

-- ── read model: add returned_quantity; realized margin now nets returns ──────
-- (drop-first: return signature changes again.) realized_margin = unit_price ×
-- (shipped − returned) − cogs, where cogs already tracks the goods still out.
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
    av.available_quantity,
    sol.returned_quantity
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

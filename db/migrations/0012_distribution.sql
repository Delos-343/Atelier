-- 0012_distribution.sql  (Phase 2a — capture + expected margin)
-- Customers and sales orders (header + lines). No stock movement yet: shipment and
-- realized COGS land in 2b. Expected margin is previewed from an estimated product
-- cost = weighted-average unit_cost of the product's AVAILABLE finished lots.
-- Writes are admin-gated for v1 (no dedicated sales role yet); reads are open to any
-- authenticated user, mirroring the master-data / production-order policy pattern.

-- ── customers (master data) ─────────────────────────────────────────────────
create table if not exists customers (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  email       text,
  phone       text,
  address     text,
  created_at  timestamptz not null default now()
);

-- ── sales orders ────────────────────────────────────────────────────────────
do $$ begin
  create type sales_order_status as enum ('draft','confirmed','shipped','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists sales_orders (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  customer_id   uuid not null references customers(id),
  warehouse_id  uuid not null references warehouses(id),  -- fulfilling location
  status        sales_order_status not null default 'draft',
  order_date    date not null default current_date,
  created_at    timestamptz not null default now()
);

create table if not exists sales_order_lines (
  id              uuid primary key default gen_random_uuid(),
  sales_order_id  uuid not null references sales_orders(id) on delete cascade,
  product_id      uuid not null references products(id),
  quantity        numeric(18,6) not null check (quantity > 0),
  unit            unit_code not null,
  unit_price      numeric(14,4) not null default 0 check (unit_price >= 0)
);
create index if not exists idx_sol_order on sales_order_lines(sales_order_id);

-- ── RLS: read for all authenticated, write for admin (v1) ───────────────────
alter table customers          enable row level security;
alter table sales_orders       enable row level security;
alter table sales_order_lines  enable row level security;
do $$
declare t text;
begin
  foreach t in array array['customers','sales_orders','sales_order_lines'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (auth.uid() is not null);$f$, t);
    execute format('drop policy if exists %1$s_write on %1$I;', t);
    execute format($f$create policy %1$s_write on %1$I for all to authenticated
                       using (current_app_role() = 'admin')
                       with check (current_app_role() = 'admin');$f$, t);
  end loop;
end $$;

-- ── estimated product cost: weighted-avg unit_cost of AVAILABLE finished lots ─
create or replace function product_available_cost(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sum(l.quantity_on_hand * l.unit_cost) / nullif(sum(l.quantity_on_hand), 0)
  from inventory_lots l
  where l.item_type = 'product'
    and l.product_id = p_product_id
    and l.status = 'available'
    and l.unit_cost is not null;
$$;
revoke execute on function product_available_cost(uuid) from public;
grant  execute on function product_available_cost(uuid) to authenticated;

-- ── atomic order creation (header + lines in one transaction) ────────────────
-- SECURITY INVOKER: the admin-write RLS above is the gate, consistent with the
-- master-data CRUD path (the API route also requires admin). Improves on the
-- production-order create, which inserts header then lines without rollback.
create or replace function create_sales_order(
  p_code text,
  p_customer_id uuid,
  p_warehouse_id uuid,
  p_order_date date,
  p_lines jsonb
) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into sales_orders(code, customer_id, warehouse_id, order_date)
  values (p_code, p_customer_id, p_warehouse_id, coalesce(p_order_date, current_date))
  returning id into v_id;

  insert into sales_order_lines(sales_order_id, product_id, quantity, unit, unit_price)
  select v_id,
         (e->>'product_id')::uuid,
         (e->>'quantity')::numeric,
         (e->>'unit')::unit_code,
         coalesce((e->>'unit_price')::numeric, 0)
  from jsonb_array_elements(p_lines) e;

  return v_id;
end;
$$;
revoke execute on function create_sales_order(text, uuid, uuid, date, jsonb) from public;
grant  execute on function create_sales_order(text, uuid, uuid, date, jsonb) to authenticated;

-- ── per-line expected cost / margin for the order detail view ────────────────
-- (drop-first: 0013 later extends this with realized columns, and a plain
--  create-or-replace cannot change a function's return type on re-run.)
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
  expected_margin numeric
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
         else (sol.unit_price - c.est_unit_cost) * sol.quantity end as expected_margin
  from sales_order_lines sol
  join products p on p.id = sol.product_id
  left join lateral (select product_available_cost(sol.product_id) as est_unit_cost) c on true
  where sol.sales_order_id = p_order_id
  order by p.sku;
$$;
revoke execute on function sales_order_lines_costed(uuid) from public;
grant  execute on function sales_order_lines_costed(uuid) to authenticated;

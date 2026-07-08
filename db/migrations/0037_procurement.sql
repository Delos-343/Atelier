-- 0037_procurement.sql  (Procurement — purchase orders that receive into inventory and feed bills)
--
-- The buy side, closing the loop. A purchase_order records what was ordered from a
-- supplier (raw-material lines with a quantity and a unit cost); receiving it turns
-- those lines into real stock — a raw lot per delivery, created through the same
-- _create_lot primitive production and returns use, with a 'receipt' movement so the
-- goods land in FEFO exactly like any other arrival. Receipts are partial-aware: each
-- line tracks how much has come in, and the order walks open → partially_received →
-- received on its own. Billing a PO reuses the payables machinery unchanged — it calls
-- create_bill and stamps the new bill with the order it came from, so money owed out is
-- tracked where it always was, now traceable back to the PO that raised it.
--
-- Orders and their lines are select-only for clients; every write goes through an
-- admin-gated DEFINER function. Receiving can't overrun a line, a cancelled or received
-- order is closed to it, and only an untouched (open) order can be cancelled.

-- ── the order and its lines ──────────────────────────────────────────────────────
create table if not exists purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  supplier_id  uuid not null references suppliers(id) on delete restrict,
  warehouse_id uuid not null references warehouses(id) on delete restrict,
  order_date   date not null default current_date,
  status       text not null default 'open'
               check (status in ('open', 'partially_received', 'received', 'cancelled')),
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists purchase_orders_supplier_idx on purchase_orders(supplier_id);

create table if not exists purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  line_no           int not null,
  raw_material_id   uuid not null references raw_materials(id) on delete restrict,
  quantity          numeric(18, 6) not null check (quantity > 0),
  unit              unit_code not null,
  unit_cost         numeric(14, 4) not null check (unit_cost >= 0),
  received_quantity numeric(18, 6) not null default 0 check (received_quantity >= 0)
);
create index if not exists purchase_order_lines_po_idx on purchase_order_lines(purchase_order_id);

alter table purchase_orders enable row level security;
revoke all on purchase_orders from authenticated;
grant select on purchase_orders to authenticated;
drop policy if exists purchase_orders_select on purchase_orders;
create policy purchase_orders_select on purchase_orders
  for select to authenticated using (auth.uid() is not null);

alter table purchase_order_lines enable row level security;
revoke all on purchase_order_lines from authenticated;
grant select on purchase_order_lines to authenticated;
drop policy if exists purchase_order_lines_select on purchase_order_lines;
create policy purchase_order_lines_select on purchase_order_lines
  for select to authenticated using (auth.uid() is not null);

-- Trace a bill back to the order that raised it (null = a bill entered by hand).
alter table bills add column if not exists purchase_order_id uuid references purchase_orders(id) on delete set null;
create index if not exists bills_purchase_order_idx on bills(purchase_order_id);

-- ── raise a purchase order ───────────────────────────────────────────────────────
create or replace function create_purchase_order(
  p_code text,
  p_supplier_id uuid,
  p_warehouse_id uuid,
  p_order_date date,
  p_lines jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_line jsonb;
  v_no   int := 0;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may raise purchase orders' using errcode = 'insufficient_privilege';
  end if;
  if p_code is null or btrim(p_code) = '' then
    raise exception 'a purchase order code is required' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a purchase order needs at least one line' using errcode = 'P0001';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id) then
    raise exception 'supplier not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id) then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;

  insert into purchase_orders(code, supplier_id, warehouse_id, order_date)
  values (btrim(p_code), p_supplier_id, p_warehouse_id, coalesce(p_order_date, current_date))
  returning id into v_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;
    if not exists (select 1 from raw_materials where id = (v_line->>'raw_material_id')::uuid) then
      raise exception 'raw material on line % not found', v_no using errcode = 'P0002';
    end if;
    if (v_line->>'quantity')::numeric is null or (v_line->>'quantity')::numeric <= 0 then
      raise exception 'quantity on line % must be greater than zero', v_no using errcode = 'P0001';
    end if;
    if coalesce((v_line->>'unit_cost')::numeric, 0) < 0 then
      raise exception 'unit cost on line % cannot be negative', v_no using errcode = 'P0001';
    end if;
    insert into purchase_order_lines(purchase_order_id, line_no, raw_material_id, quantity, unit, unit_cost)
    values (
      v_id,
      v_no,
      (v_line->>'raw_material_id')::uuid,
      (v_line->>'quantity')::numeric,
      (v_line->>'unit')::unit_code,
      coalesce((v_line->>'unit_cost')::numeric, 0));
  end loop;

  return v_id;
end;
$$;
revoke execute on function create_purchase_order(text, uuid, uuid, date, jsonb) from public;
grant  execute on function create_purchase_order(text, uuid, uuid, date, jsonb) to authenticated;

-- ── receive against a purchase order ─────────────────────────────────────────────
-- Each receipt line becomes a raw lot (through _create_lot, the one privileged insert)
-- carrying the line's material, unit and cost into the PO's warehouse, then a 'receipt'
-- movement lands the quantity so it enters FEFO. A line can't be over-received, and the
-- order's status is recomputed from its lines afterwards.
create or replace function receive_purchase_order(p_po_id uuid, p_receipts jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po           purchase_orders%rowtype;
  v_r            jsonb;
  v_line         purchase_order_lines%rowtype;
  v_qty          numeric;
  v_lot_code     text;
  v_expiry       date;
  v_lot_id       uuid;
  v_remaining    numeric;
  v_all_received boolean;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may receive purchase orders' using errcode = 'insufficient_privilege';
  end if;
  if p_receipts is null or jsonb_typeof(p_receipts) <> 'array' or jsonb_array_length(p_receipts) = 0 then
    raise exception 'at least one receipt line is required' using errcode = 'P0001';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'purchase order not found' using errcode = 'P0002';
  end if;
  if v_po.status = 'cancelled' then
    raise exception 'this purchase order is cancelled and cannot receive stock' using errcode = 'P0001';
  end if;
  if v_po.status = 'received' then
    raise exception 'this purchase order is already fully received' using errcode = 'P0001';
  end if;

  for v_r in select value from jsonb_array_elements(p_receipts) loop
    v_qty      := (v_r->>'quantity')::numeric;
    v_lot_code := btrim(coalesce(v_r->>'lotCode', ''));
    v_expiry   := nullif(v_r->>'expiryDate', '')::date;

    if v_qty is null or v_qty <= 0 then
      raise exception 'each received quantity must be greater than zero' using errcode = 'P0001';
    end if;
    if v_lot_code = '' then
      raise exception 'each receipt needs a lot code' using errcode = 'P0001';
    end if;

    select * into v_line from purchase_order_lines
      where id = (v_r->>'lineId')::uuid and purchase_order_id = p_po_id
      for update;
    if not found then
      raise exception 'a receipt line does not belong to this purchase order' using errcode = 'P0001';
    end if;

    v_remaining := v_line.quantity - v_line.received_quantity;
    if v_qty > v_remaining then
      raise exception 'receiving % exceeds the % still outstanding on this line',
        to_char(v_qty, 'FM999999990.######'),
        to_char(v_remaining, 'FM999999990.######')
        using errcode = 'P0001';
    end if;

    -- Born empty through the primitive; expiry stamped before stock arrives; then received.
    v_lot_id := _create_lot(v_lot_code, 'raw', v_line.raw_material_id, null,
                            v_po.warehouse_id, v_line.unit, 'available', v_line.unit_cost);
    if v_expiry is not null then
      update inventory_lots set expiry_date = v_expiry where id = v_lot_id;
    end if;
    perform post_movement(v_lot_id, 'receipt', v_qty, v_line.unit, 'purchase_order', p_po_id, auth.uid());

    update purchase_order_lines
       set received_quantity = received_quantity + v_qty
     where id = v_line.id;
  end loop;

  select bool_and(received_quantity >= quantity) into v_all_received
    from purchase_order_lines where purchase_order_id = p_po_id;
  update purchase_orders
     set status = case when coalesce(v_all_received, false) then 'received' else 'partially_received' end
   where id = p_po_id;
end;
$$;
revoke execute on function receive_purchase_order(uuid, jsonb) from public;
grant  execute on function receive_purchase_order(uuid, jsonb) to authenticated;

-- ── cancel an untouched order ────────────────────────────────────────────────────
create or replace function cancel_purchase_order(p_po_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po purchase_orders%rowtype;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may cancel purchase orders' using errcode = 'insufficient_privilege';
  end if;
  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'purchase order not found' using errcode = 'P0002';
  end if;
  if v_po.status <> 'open' then
    raise exception 'only an open purchase order can be cancelled (this one is %)', v_po.status
      using errcode = 'P0001';
  end if;
  update purchase_orders set status = 'cancelled' where id = p_po_id;
end;
$$;
revoke execute on function cancel_purchase_order(uuid) from public;
grant  execute on function cancel_purchase_order(uuid) to authenticated;

-- ── bill a purchase order (feeds payables) ───────────────────────────────────────
-- Reuses create_bill, then stamps the bill with its order. The amount defaults to the
-- received value (what actually arrived), falling back to the ordered value if nothing
-- has been received yet; an explicit amount overrides both. The tax parameter (v0.43)
-- carries the supplier invoice's input PPN onto the bill.
drop function if exists bill_purchase_order(uuid, text, date, numeric, date, text);
create or replace function bill_purchase_order(
  p_po_id uuid,
  p_bill_number text,
  p_bill_date date,
  p_amount numeric default null,
  p_due_date date default null,
  p_description text default null,
  p_tax_amount numeric default 0
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_po      purchase_orders%rowtype;
  v_amount  numeric;
  v_bill_id uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may bill purchase orders' using errcode = 'insufficient_privilege';
  end if;
  select * into v_po from purchase_orders where id = p_po_id;
  if not found then
    raise exception 'purchase order not found' using errcode = 'P0002';
  end if;

  if p_amount is not null then
    v_amount := p_amount;
  else
    select coalesce(sum(round(received_quantity * unit_cost, 2)), 0) into v_amount
      from purchase_order_lines where purchase_order_id = p_po_id;
    if v_amount <= 0 then
      select coalesce(sum(round(quantity * unit_cost, 2)), 0) into v_amount
        from purchase_order_lines where purchase_order_id = p_po_id;
    end if;
  end if;

  -- create_bill enforces the admin gate, the >0 and 2dp checks, and the due-date default.
  v_bill_id := create_bill(
    v_po.supplier_id,
    p_bill_number,
    coalesce(p_bill_date, current_date),
    v_amount,
    p_due_date,
    coalesce(nullif(btrim(p_description), ''), 'Purchase order ' || v_po.code),
    coalesce(p_tax_amount, 0));
  update bills set purchase_order_id = p_po_id where id = v_bill_id;
  return v_bill_id;
end;
$$;
revoke execute on function bill_purchase_order(uuid, text, date, numeric, date, text, numeric) from public;
grant  execute on function bill_purchase_order(uuid, text, date, numeric, date, text, numeric) to authenticated;

-- ── the register: one row per order with ordered / received / billed value ───────
drop function if exists purchase_order_register(uuid);
create or replace function purchase_order_register(p_po_id uuid default null)
returns table(
  purchase_order_id uuid,
  code text,
  supplier_id uuid,
  supplier_name text,
  warehouse_name text,
  order_date date,
  status text,
  line_count int,
  ordered_value numeric,
  received_value numeric,
  billed numeric,
  billed_tax numeric,
  billed_net numeric,
  variance numeric,
  match_status text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Three-way match: the bill (net of PPN) reconciled against the goods actually received,
  -- valued at PO prices. received_value = Σ round(received_qty × unit_cost) is what came in;
  -- billed_net = Σ(bill.amount − bill.tax) is what the supplier is charging for the goods;
  -- variance is the gap. A positive variance is an over-bill — charged for more than was
  -- received — which is the one to catch before it's paid.
  with reg as (
    select
      po.id,
      po.code,
      po.supplier_id,
      s.name  as supplier_name,
      w.name  as warehouse_name,
      po.order_date,
      po.status,
      po.created_at,
      (select count(*) from purchase_order_lines l where l.purchase_order_id = po.id)::int as line_count,
      coalesce((select sum(round(l.quantity * l.unit_cost, 2))
                  from purchase_order_lines l where l.purchase_order_id = po.id), 0) as ordered_value,
      coalesce((select sum(round(l.received_quantity * l.unit_cost, 2))
                  from purchase_order_lines l where l.purchase_order_id = po.id), 0) as received_value,
      coalesce((select sum(b.amount)
                  from bills b where b.purchase_order_id = po.id and b.voided_at is null), 0) as billed,
      coalesce((select sum(b.tax_amount)
                  from bills b where b.purchase_order_id = po.id and b.voided_at is null), 0) as billed_tax
    from purchase_orders po
    join suppliers s on s.id = po.supplier_id
    join warehouses w on w.id = po.warehouse_id
    where (p_po_id is null or po.id = p_po_id)
  )
  select
    id, code, supplier_id, supplier_name, warehouse_name, order_date, status, line_count,
    ordered_value, received_value, billed, billed_tax,
    (billed - billed_tax) as billed_net,
    round((billed - billed_tax) - received_value, 2) as variance,
    case
      when billed - billed_tax = 0                                     then 'unbilled'
      when abs(round((billed - billed_tax) - received_value, 2)) < 0.01 then 'matched'
      when (billed - billed_tax) > received_value                      then 'over_billed'
      else                                                                  'under_billed'
    end as match_status
  from reg
  order by order_date desc, created_at desc;
$$;
revoke execute on function purchase_order_register(uuid) from public;
grant  execute on function purchase_order_register(uuid) to authenticated;

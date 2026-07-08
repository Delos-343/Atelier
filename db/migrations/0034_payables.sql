-- 0034_payables.sql  (Accounts payable — the money-owed-out mirror of receivables)
--
-- Everything here mirrors the receivables side, so money owed out is tracked with the
-- same rigour as money owed in: suppliers mirror customers; bills mirror issued
-- invoices (a claim with an amount, a bill date, and a due date from the supplier's
-- terms); bill_payments mirror invoice_payments; bill_payables() is the single
-- derivation (open = amount − paid, with a status and an overdue flag) reused by the
-- payables register and payables_aging(), exactly as invoice_receivables() is on the
-- other side. Bills are written only through DEFINER functions and are select-only for
-- clients; suppliers are admin-managed master data like customers.

-- ── suppliers (vendors we buy from) — mirror of customers ────────────────────────
create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique not null,
  name               text not null,
  email              text,
  phone              text,
  address            text,
  payment_terms_days int not null default 30 check (payment_terms_days >= 0),
  created_at         timestamptz not null default now()
);
alter table suppliers enable row level security;
-- read for all authenticated, write for admin (mirrors customers)
drop policy if exists suppliers_select on suppliers;
create policy suppliers_select on suppliers for select to authenticated
  using (auth.uid() is not null);
drop policy if exists suppliers_write on suppliers;
create policy suppliers_write on suppliers for all to authenticated
  using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
-- Master data created after 0003's blanket grant, so grant explicitly (the write
-- policy above still restricts writes to admin); this makes a single from-zero
-- migration self-sufficient rather than relying on a second pass.
grant select, insert, update, delete on suppliers to authenticated;

-- ── bills (supplier invoices we owe) — mirror of issued invoices ─────────────────
create table if not exists bills (
  id           uuid primary key default gen_random_uuid(),
  supplier_id  uuid not null references suppliers(id) on delete restrict,
  bill_number  text not null,                 -- the supplier's own reference
  bill_date    date not null default current_date,
  due_date     date,                          -- bill_date + supplier terms, set at creation
  amount       numeric(14, 2) not null check (amount > 0),
  description  text,
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists bills_supplier_idx on bills(supplier_id, bill_date desc);

-- The input-PPN portion of a bill (v0.43): the tax already inside `amount`, held so the
-- tax report can total input tax without re-deriving it. Added by ALTER so a database
-- carrying the pre-tax bills table gains it on re-migration.
alter table bills add column if not exists tax_amount numeric(14, 2) not null default 0 check (tax_amount >= 0);

alter table bills enable row level security;
-- Written only inside the DEFINER functions below — select-only for clients. Explicit
-- revoke + grant so the posture survives re-migration (0003's blanket grant re-runs).
revoke all on bills from authenticated;
grant select on bills to authenticated;
drop policy if exists bills_select on bills;
create policy bills_select on bills for select to authenticated
  using (auth.uid() is not null);

-- ── bill_payments (money we pay out) — mirror of invoice_payments ────────────────
create table if not exists bill_payments (
  id           uuid primary key default gen_random_uuid(),
  bill_id      uuid not null references bills(id) on delete restrict,
  amount       numeric(14, 2) not null check (amount > 0),
  paid_date    date not null default current_date,
  method       text,                                    -- free text: bank transfer, QRIS, cash, …
  reference    text,
  recorded_by  uuid,
  recorded_at  timestamptz not null default now()
);
create index if not exists bill_payments_bill_idx on bill_payments(bill_id, paid_date desc);

alter table bill_payments enable row level security;
revoke all on bill_payments from authenticated;
grant select on bill_payments to authenticated;
drop policy if exists bill_payments_select on bill_payments;
create policy bill_payments_select on bill_payments for select to authenticated
  using (auth.uid() is not null);

-- ── bill_payables(): the single AP derivation (mirror of invoice_receivables) ────
create or replace function bill_payables(p_supplier_id uuid default null)
returns table(
  bill_id uuid,
  bill_number text,
  supplier_id uuid,
  supplier_name text,
  bill_date date,
  due_date date,
  amount numeric,
  paid numeric,
  open numeric,
  status text,
  overdue boolean,
  payment_count int,
  last_paid_date date,
  void_reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.id,
    b.bill_number,
    b.supplier_id,
    s.name,
    b.bill_date,
    b.due_date,
    b.amount,
    coalesce(p.paid, 0)                    as paid,
    b.amount - coalesce(p.paid, 0)         as open,
    case
      when b.voided_at is not null then 'void'
      when b.amount - coalesce(p.paid, 0) <= 0 then 'paid'
      when coalesce(p.paid, 0) > 0 then 'partially_paid'
      else 'open'
    end                                    as status,
    (
      b.voided_at is null
      and b.due_date is not null
      and b.due_date < current_date
      and b.amount - coalesce(p.paid, 0) > 0
    )                                      as overdue,
    coalesce(p.n, 0)::int                  as payment_count,
    p.last_paid                            as last_paid_date,
    b.void_reason
  from bills b
  join suppliers s on s.id = b.supplier_id
  left join lateral (
    select sum(bp.amount) as paid, count(*) as n, max(bp.paid_date) as last_paid
    from bill_payments bp
    where bp.bill_id = b.id
  ) p on true
  where (p_supplier_id is null or b.supplier_id = p_supplier_id)
  order by b.bill_date desc, b.created_at desc;
$$;
revoke execute on function bill_payables(uuid) from public;
grant  execute on function bill_payables(uuid) to authenticated;

-- ── payables_aging(): bucket by due date (mirror of receivables_aging) ───────────
create or replace function payables_aging(p_as_of date default current_date)
returns table(
  supplier_id uuid,
  supplier_name text,
  bill_id uuid,
  bill_number text,
  bill_date date,
  due_date date,
  days_overdue int,
  bucket text,            -- 'current' (not due) | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'
  amount numeric,
  paid numeric,
  open numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    b.supplier_id,
    b.supplier_name,
    b.bill_id,
    b.bill_number,
    b.bill_date,
    coalesce(b.due_date, b.bill_date)               as due_date,
    (p_as_of - coalesce(b.due_date, b.bill_date))   as days_overdue,
    case
      when (p_as_of - coalesce(b.due_date, b.bill_date)) <= 0  then 'current'
      when (p_as_of - coalesce(b.due_date, b.bill_date)) <= 30 then 'd1_30'
      when (p_as_of - coalesce(b.due_date, b.bill_date)) <= 60 then 'd31_60'
      when (p_as_of - coalesce(b.due_date, b.bill_date)) <= 90 then 'd61_90'
      else 'd90_plus'
    end                                             as bucket,
    b.amount,
    b.paid,
    b.open
  from bill_payables() b
  where b.status in ('open', 'partially_paid')
    and b.open > 0
  order by b.supplier_name, coalesce(b.due_date, b.bill_date);
$$;
revoke execute on function payables_aging(date) from public;
grant  execute on function payables_aging(date) to authenticated;

-- ── create a bill (due date from the supplier's terms unless given) ──────────────
-- create_bill gained a tax parameter in v0.43; drop the pre-tax signature so the
-- redefinition is a clean replace rather than a lingering overload.
drop function if exists create_bill(uuid, text, date, numeric, date, text);
create or replace function create_bill(
  p_supplier_id uuid,
  p_bill_number text,
  p_bill_date date,
  p_amount numeric,
  p_due_date date default null,
  p_description text default null,
  p_tax_amount numeric default 0
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_terms int;
  v_due   date;
  v_id    uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may enter bills' using errcode = 'insufficient_privilege';
  end if;
  if p_bill_number is null or btrim(p_bill_number) = '' then
    raise exception 'a bill number is required' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the bill amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'the bill amount must have at most 2 decimal places' using errcode = 'P0001';
  end if;
  if coalesce(p_tax_amount, 0) < 0 or coalesce(p_tax_amount, 0) <> round(coalesce(p_tax_amount, 0), 2) then
    raise exception 'the tax amount must be zero or more, with at most 2 decimal places' using errcode = 'P0001';
  end if;
  if coalesce(p_tax_amount, 0) > p_amount then
    raise exception 'the tax amount cannot exceed the bill amount' using errcode = 'P0001';
  end if;

  select payment_terms_days into v_terms from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'supplier not found' using errcode = 'P0002';
  end if;

  -- Honour an explicit due date, else derive it from the supplier's terms.
  v_due := coalesce(p_due_date, coalesce(p_bill_date, current_date) + coalesce(v_terms, 0));

  insert into bills(supplier_id, bill_number, bill_date, due_date, amount, tax_amount, description, created_by)
  values (
    p_supplier_id,
    btrim(p_bill_number),
    coalesce(p_bill_date, current_date),
    v_due,
    p_amount,
    coalesce(p_tax_amount, 0),
    nullif(btrim(coalesce(p_description, '')), ''),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ── record a payment against a bill: locked, never past the amount, never on a void ─
create or replace function record_bill_payment(
  p_bill_id uuid,
  p_amount numeric,
  p_paid_date date default current_date,
  p_method text default null,
  p_reference text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill bills%rowtype;
  v_paid numeric;
  v_id   uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may record payments' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the payment amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'the payment amount must have at most 2 decimal places' using errcode = 'P0001';
  end if;

  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  if v_bill.voided_at is not null then
    raise exception 'this bill is voided; no payment can be recorded against it' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid from bill_payments where bill_id = p_bill_id;
  if v_paid + p_amount > v_bill.amount then
    raise exception 'payment of % exceeds the open balance of % on bill %',
      to_char(p_amount, 'FM999999990.00'),
      to_char(v_bill.amount - v_paid, 'FM999999990.00'),
      v_bill.bill_number
      using errcode = 'P0001';
  end if;

  insert into bill_payments(bill_id, amount, paid_date, method, reference, recorded_by)
  values (
    p_bill_id,
    p_amount,
    coalesce(p_paid_date, current_date),
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_reference, '')), ''),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ── delete a bill payment (admin correction; reopens the balance) ────────────────
create or replace function delete_bill_payment(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may delete payments' using errcode = 'insufficient_privilege';
  end if;
  delete from bill_payments where id = p_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ── void a bill (mirror of void_issued_document) ─────────────────────────────────
create or replace function void_bill(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill     bills%rowtype;
  v_payments int;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may void bills' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to void a bill' using errcode = 'P0001';
  end if;

  select * into v_bill from bills where id = p_id for update;
  if not found then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  if v_bill.voided_at is not null then
    raise exception 'this bill is already voided' using errcode = 'P0001';
  end if;

  select count(*) into v_payments from bill_payments where bill_id = p_id;
  if v_payments > 0 then
    raise exception 'a bill with recorded payments cannot be voided — remove its payments first'
      using errcode = 'P0001';
  end if;

  update bills
     set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   where id = p_id;
end;
$$;

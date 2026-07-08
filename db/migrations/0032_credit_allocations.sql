-- 0032_credit_allocations.sql  (Credit-note allocation — apply a credit note to an open invoice)
--
-- Until now a credit note was only a document; the sole way to reduce an invoice's
-- open balance was cash (record_invoice_payment). This closes the returns → receivables
-- loop: a credit note can be APPLIED against one or more of the same customer's open
-- invoices, reducing their balances without cash changing hands. A credit note thus
-- becomes a claim in the customer's favour — with its own allocated / remaining — and an
-- invoice's open balance is now `total − paid − allocated`.
--
-- The change lands where it must: invoice_receivables() — the single derivation reused
-- by the receivables register, the documents register, and aging — is recreated to net
-- allocations. Every consumer that reads `open` now nets credits automatically; they read
-- by column name, so the added `allocated` column is backward-compatible.

-- ── the allocation: a slice of a credit note applied to an invoice ───────────────
create table if not exists credit_allocations (
  id             uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references issued_documents(id) on delete restrict,
  invoice_id     uuid not null references issued_documents(id) on delete restrict,
  amount         numeric(14, 2) not null check (amount > 0),
  allocated_date date not null default current_date,
  allocated_by   uuid,
  created_at     timestamptz not null default now()
);
create index if not exists credit_allocations_credit_note_idx on credit_allocations(credit_note_id);
create index if not exists credit_allocations_invoice_idx on credit_allocations(invoice_id);

alter table credit_allocations enable row level security;
-- Select-only for clients (writes go through the DEFINER functions below). Explicit
-- revoke + grant so the posture survives re-migration (0003's blanket grant re-runs).
revoke all on credit_allocations from authenticated;
grant select on credit_allocations to authenticated;
drop policy if exists credit_allocations_read on credit_allocations;
create policy credit_allocations_read on credit_allocations
  for select using (auth.uid() is not null);

-- ── invoice_receivables(): now nets credit allocations into the open balance ─────
-- The return signature gains `allocated`, so the old function must be dropped first
-- (create-or-replace cannot change a return type). Callers resolve it at run time —
-- receivables_aging() and issued_documents_register() are unaffected by the drop.
drop function if exists invoice_receivables(uuid);
create or replace function invoice_receivables(p_order_id uuid default null)
returns table(
  issued_document_id uuid,
  document_number text,
  sales_order_id uuid,
  order_code text,
  customer_name text,
  issued_at timestamptz,
  total numeric,
  paid numeric,
  allocated numeric,
  open numeric,
  status text,
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
    d.id,
    d.document_number,
    d.sales_order_id,
    so.code,
    c.name,
    d.issued_at,
    d.total,
    coalesce(p.paid, 0)                                          as paid,
    coalesce(a.allocated, 0)                                     as allocated,
    d.total - coalesce(p.paid, 0) - coalesce(a.allocated, 0)     as open,
    case
      when d.voided_at is not null then 'void'
      when d.total - coalesce(p.paid, 0) - coalesce(a.allocated, 0) <= 0 and d.total > 0 then 'paid'
      when coalesce(p.paid, 0) + coalesce(a.allocated, 0) > 0 then 'partially_paid'
      else 'open'
    end                                                         as status,
    coalesce(p.n, 0)::int                                        as payment_count,
    p.last_paid                                                 as last_paid_date,
    d.void_reason
  from issued_documents d
  join sales_orders so on so.id = d.sales_order_id
  join customers c on c.id = so.customer_id
  left join lateral (
    select sum(ip.amount) as paid, count(*) as n, max(ip.paid_date) as last_paid
    from invoice_payments ip
    where ip.issued_document_id = d.id
  ) p on true
  left join lateral (
    select sum(al.amount) as allocated
    from credit_allocations al
    where al.invoice_id = d.id
  ) a on true
  where d.kind = 'invoice'
    and (p_order_id is null or d.sales_order_id = p_order_id)
  order by d.issued_at desc;
$$;
revoke execute on function invoice_receivables(uuid) from public;
grant  execute on function invoice_receivables(uuid) to authenticated;

-- ── credit note balances: total / allocated / remaining, per credit note ─────────
-- Serves both the order page (p_order_id) and the picker of a customer's usable
-- credit (p_customer_id); includes fully-applied notes (remaining 0) so the order
-- page can show them.
create or replace function credit_note_balances(
  p_order_id uuid default null,
  p_customer_id uuid default null
)
returns table(
  issued_document_id uuid,
  document_number text,
  sales_order_id uuid,
  order_code text,
  customer_id uuid,
  customer_name text,
  issued_at timestamptz,
  total numeric,
  allocated numeric,
  remaining numeric,
  voided boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.document_number,
    d.sales_order_id,
    so.code,
    so.customer_id,
    c.name,
    d.issued_at,
    d.total,
    coalesce(a.allocated, 0)              as allocated,
    d.total - coalesce(a.allocated, 0)    as remaining,
    d.voided_at is not null
  from issued_documents d
  join sales_orders so on so.id = d.sales_order_id
  join customers c on c.id = so.customer_id
  left join lateral (
    select sum(al.amount) as allocated
    from credit_allocations al
    where al.credit_note_id = d.id
  ) a on true
  where d.kind = 'credit_note'
    and (p_order_id is null or d.sales_order_id = p_order_id)
    and (p_customer_id is null or so.customer_id = p_customer_id)
  order by d.issued_at desc;
$$;
revoke execute on function credit_note_balances(uuid, uuid) from public;
grant  execute on function credit_note_balances(uuid, uuid) to authenticated;

-- ── allocations touching an order's documents (for display + delete) ─────────────
create or replace function credit_allocations_view(p_order_id uuid default null)
returns table(
  allocation_id uuid,
  amount numeric,
  allocated_date date,
  invoice_id uuid,
  invoice_number text,
  invoice_order_id uuid,
  credit_note_id uuid,
  credit_note_number text,
  credit_note_order_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    al.id,
    al.amount,
    al.allocated_date,
    inv.id,
    inv.document_number,
    inv.sales_order_id,
    cn.id,
    cn.document_number,
    cn.sales_order_id
  from credit_allocations al
  join issued_documents inv on inv.id = al.invoice_id
  join issued_documents cn on cn.id = al.credit_note_id
  where p_order_id is null
     or inv.sales_order_id = p_order_id
     or cn.sales_order_id = p_order_id
  order by al.allocated_date desc, al.created_at desc;
$$;
revoke execute on function credit_allocations_view(uuid) from public;
grant  execute on function credit_allocations_view(uuid) to authenticated;

-- ── apply a credit note to an invoice ────────────────────────────────────────────
create or replace function allocate_credit_note(
  p_credit_note_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_allocated_date date default current_date
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cn            issued_documents%rowtype;
  v_inv           issued_documents%rowtype;
  v_cn_customer   uuid;
  v_inv_customer  uuid;
  v_cn_allocated  numeric;
  v_inv_paid      numeric;
  v_inv_allocated numeric;
  v_cn_remaining  numeric;
  v_inv_open      numeric;
  v_id            uuid;
begin
  -- Reachable by any authenticated user via PostgREST, so the admin gate lives here
  -- too (the API route is admin-gated as well).
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may allocate credit notes'
      using errcode = 'insufficient_privilege';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'the allocation amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'the allocation amount must have at most 2 decimal places' using errcode = 'P0001';
  end if;
  if p_credit_note_id = p_invoice_id then
    raise exception 'a document cannot be allocated against itself' using errcode = 'P0001';
  end if;

  -- Lock both documents in a stable id order so concurrent allocations, payments,
  -- and voids serialize without deadlocking; the balance checks below are then race-free.
  perform 1 from issued_documents
    where id in (p_credit_note_id, p_invoice_id)
    order by id
    for update;

  select * into v_cn from issued_documents where id = p_credit_note_id;
  if not found then
    raise exception 'credit note not found' using errcode = 'P0002';
  end if;
  if v_cn.kind <> 'credit_note' then
    raise exception 'the source document must be a credit note' using errcode = 'P0001';
  end if;
  if v_cn.voided_at is not null then
    raise exception 'this credit note is voided; it cannot be allocated' using errcode = 'P0001';
  end if;
  if v_cn.total is null then
    raise exception 'this credit note carries no amount to allocate' using errcode = 'P0001';
  end if;

  select * into v_inv from issued_documents where id = p_invoice_id;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if v_inv.kind <> 'invoice' then
    raise exception 'a credit note can only be applied to an invoice' using errcode = 'P0001';
  end if;
  if v_inv.voided_at is not null then
    raise exception 'this invoice is voided; no credit can be applied to it' using errcode = 'P0001';
  end if;

  -- Same customer: a customer's credit applies only to that customer's invoices.
  select so.customer_id into v_cn_customer from sales_orders so where so.id = v_cn.sales_order_id;
  select so.customer_id into v_inv_customer from sales_orders so where so.id = v_inv.sales_order_id;
  if v_cn_customer is distinct from v_inv_customer then
    raise exception 'the credit note and invoice belong to different customers' using errcode = 'P0001';
  end if;

  -- Credit remaining on the note.
  select coalesce(sum(amount), 0) into v_cn_allocated
    from credit_allocations where credit_note_id = p_credit_note_id;
  v_cn_remaining := v_cn.total - v_cn_allocated;
  if p_amount > v_cn_remaining then
    raise exception 'allocation of % exceeds credit note % remaining balance of %',
      to_char(p_amount, 'FM999999990.00'),
      v_cn.document_number,
      to_char(v_cn_remaining, 'FM999999990.00')
      using errcode = 'P0001';
  end if;

  -- Open balance on the invoice, net of payments AND prior allocations.
  select coalesce(sum(amount), 0) into v_inv_paid
    from invoice_payments where issued_document_id = p_invoice_id;
  select coalesce(sum(amount), 0) into v_inv_allocated
    from credit_allocations where invoice_id = p_invoice_id;
  v_inv_open := v_inv.total - v_inv_paid - v_inv_allocated;
  if p_amount > v_inv_open then
    raise exception 'allocation of % exceeds the open balance of % on invoice %',
      to_char(p_amount, 'FM999999990.00'),
      to_char(v_inv_open, 'FM999999990.00'),
      v_inv.document_number
      using errcode = 'P0001';
  end if;

  insert into credit_allocations(credit_note_id, invoice_id, amount, allocated_date, allocated_by)
  values (
    p_credit_note_id,
    p_invoice_id,
    p_amount,
    coalesce(p_allocated_date, current_date),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ── remove an allocation (reopens both balances) ─────────────────────────────────
create or replace function delete_credit_allocation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may remove credit allocations'
      using errcode = 'insufficient_privilege';
  end if;
  delete from credit_allocations where id = p_id;
  if not found then
    raise exception 'credit allocation not found' using errcode = 'P0002';
  end if;
end;
$$;

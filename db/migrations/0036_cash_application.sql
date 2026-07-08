-- 0036_cash_application.sql  (Cash application — one receipt across many invoices)
--
-- Until now a payment settled a single invoice. Real collection doesn't work that way:
-- a customer sends one lump against a statement, and it clears several invoices at once
-- — sometimes with money left over, sitting on account until the next bill. This models
-- that as a customer_receipt (the lump received) whose applications ARE invoice_payments,
-- each tagged with the receipt that produced it. Because the applications are ordinary
-- invoice_payments, invoice_receivables(), the aging report and the statements all count
-- them with nothing changed — the same trick that let issued totals carry tax for free.
-- The unapplied remainder of a receipt is money on account: amount − Σ(its applications).
--
-- Receipts are select-only for clients and written only through the DEFINER functions;
-- a single application is corrected with the existing delete_invoice_payment (the invoice
-- reopens), and deleting a whole receipt cascades its applications away (every invoice it
-- touched reopens).

-- ── the lump received from a customer ────────────────────────────────────────────
create table if not exists customer_receipts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete restrict,
  receipt_date date not null default current_date,
  amount       numeric(14, 2) not null check (amount > 0),
  method       text,
  reference    text,
  recorded_by  uuid,
  recorded_at  timestamptz not null default now()
);
create index if not exists customer_receipts_customer_idx on customer_receipts(customer_id);

alter table customer_receipts enable row level security;
revoke all on customer_receipts from authenticated;
grant select on customer_receipts to authenticated;
drop policy if exists customer_receipts_select on customer_receipts;
create policy customer_receipts_select on customer_receipts
  for select to authenticated using (auth.uid() is not null);

-- Tag each payment with the receipt that produced it (null = a standalone single
-- payment recorded straight against one invoice). Cascade: dropping a receipt reverses
-- its applications, and every invoice it settled reopens through the derivation.
alter table invoice_payments
  add column if not exists receipt_id uuid references customer_receipts(id) on delete cascade;
create index if not exists invoice_payments_receipt_idx on invoice_payments(receipt_id);

-- ── a customer's live invoices that still carry a balance (for allocation) ───────
create or replace function customer_open_invoices(p_customer_id uuid)
returns table(
  issued_document_id uuid,
  document_number text,
  issued_at timestamptz,
  due_date date,
  total numeric,
  paid numeric,
  allocated numeric,
  open numeric,
  status text,
  overdue boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.issued_document_id, r.document_number, r.issued_at, r.due_date,
         r.total, r.paid, r.allocated, r.open, r.status, r.overdue
  from invoice_receivables() r
  join issued_documents d on d.id = r.issued_document_id
  join sales_orders so on so.id = d.sales_order_id
  where so.customer_id = p_customer_id
    and r.status in ('open', 'partially_paid')
    and r.open > 0
  order by r.due_date, r.issued_at;
$$;
revoke execute on function customer_open_invoices(uuid) from public;
grant  execute on function customer_open_invoices(uuid) to authenticated;

-- ── apply (more of) a receipt's balance across invoices ──────────────────────────
-- The workhorse. Charges each allocation to the receipt as an invoice_payment, after
-- checking the receipt has the unapplied balance to cover the batch and that each
-- invoice is a live invoice billed to the receipt's customer with the open balance to
-- absorb its share (open = total − paid − credit allocations, the true figure). The
-- receipt row is locked, so concurrent applications can't jointly overspend it.
create or replace function apply_receipt(p_receipt_id uuid, p_allocations jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt customer_receipts%rowtype;
  v_applied numeric;
  v_sum     numeric := 0;
  v_alloc   jsonb;
  v_inv_id  uuid;
  v_amt     numeric;
  v_doc     issued_documents%rowtype;
  v_paid    numeric;
  v_credit  numeric;
  v_open    numeric;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may apply receipts' using errcode = 'insufficient_privilege';
  end if;
  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'at least one allocation is required' using errcode = 'P0001';
  end if;

  -- Lock the receipt: concurrent applications serialize, so the balance check holds.
  select * into v_receipt from customer_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;

  select coalesce(sum(amount), 0) into v_applied
    from invoice_payments where receipt_id = p_receipt_id;

  -- First pass: validate shape and total against the receipt's unapplied balance.
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    v_amt := (v_alloc->>'amount')::numeric;
    if v_amt is null or v_amt <= 0 then
      raise exception 'each allocation amount must be greater than zero' using errcode = 'P0001';
    end if;
    if v_amt <> round(v_amt, 2) then
      raise exception 'each allocation amount must have at most 2 decimal places' using errcode = 'P0001';
    end if;
    v_sum := v_sum + v_amt;
  end loop;

  if v_applied + v_sum > v_receipt.amount then
    raise exception 'these allocations total %, more than the receipt''s unapplied balance of %',
      to_char(v_sum, 'FM999999990.00'),
      to_char(v_receipt.amount - v_applied, 'FM999999990.00')
      using errcode = 'P0001';
  end if;

  -- Second pass: apply each against its invoice.
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    v_inv_id := (v_alloc->>'invoiceId')::uuid;
    v_amt    := (v_alloc->>'amount')::numeric;

    select * into v_doc from issued_documents where id = v_inv_id for update;
    if not found then
      raise exception 'invoice not found' using errcode = 'P0002';
    end if;
    if v_doc.kind <> 'invoice' or v_doc.voided_at is not null then
      raise exception 'allocations apply to live invoices only' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from sales_orders so
      where so.id = v_doc.sales_order_id and so.customer_id = v_receipt.customer_id
    ) then
      raise exception 'invoice % is not billed to this customer', v_doc.document_number
        using errcode = 'P0001';
    end if;

    select coalesce(sum(amount), 0) into v_paid
      from invoice_payments where issued_document_id = v_inv_id;
    select coalesce(sum(amount), 0) into v_credit
      from credit_allocations where invoice_id = v_inv_id;
    v_open := coalesce(v_doc.total, 0) - v_paid - v_credit;

    if v_amt > v_open then
      raise exception 'applying % to % exceeds its open balance of %',
        to_char(v_amt, 'FM999999990.00'),
        v_doc.document_number,
        to_char(v_open, 'FM999999990.00')
        using errcode = 'P0001';
    end if;

    insert into invoice_payments(issued_document_id, amount, paid_date, method, reference, recorded_by, receipt_id)
    values (v_inv_id, v_amt, v_receipt.receipt_date, v_receipt.method, v_receipt.reference, auth.uid(), p_receipt_id);
  end loop;
end;
$$;
revoke execute on function apply_receipt(uuid, jsonb) from public;
grant  execute on function apply_receipt(uuid, jsonb) to authenticated;

-- ── record a receipt and apply it in one go ──────────────────────────────────────
-- The common entry point: bank the lump, then clear the chosen invoices. Allocations
-- may be omitted to bank money purely on account, or may total less than the amount to
-- leave a remainder on account. Everything runs in one transaction.
create or replace function apply_customer_receipt(
  p_customer_id uuid,
  p_receipt_date date,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_allocations jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may record receipts' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'the receipt amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'the receipt amount must have at most 2 decimal places' using errcode = 'P0001';
  end if;
  if not exists (select 1 from customers where id = p_customer_id) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;

  insert into customer_receipts(customer_id, receipt_date, amount, method, reference, recorded_by)
  values (
    p_customer_id,
    coalesce(p_receipt_date, current_date),
    p_amount,
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_reference, '')), ''),
    auth.uid())
  returning id into v_id;

  if p_allocations is not null
     and jsonb_typeof(p_allocations) = 'array'
     and jsonb_array_length(p_allocations) > 0 then
    perform apply_receipt(v_id, p_allocations);
  end if;

  return v_id;
end;
$$;
revoke execute on function apply_customer_receipt(uuid, date, numeric, text, text, jsonb) from public;
grant  execute on function apply_customer_receipt(uuid, date, numeric, text, text, jsonb) to authenticated;

-- ── delete a receipt (reverses every application it made) ────────────────────────
create or replace function delete_receipt(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may delete receipts' using errcode = 'insufficient_privilege';
  end if;
  delete from customer_receipts where id = p_id;  -- cascades to its applications; invoices reopen
  if not found then
    raise exception 'receipt not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function delete_receipt(uuid) from public;
grant  execute on function delete_receipt(uuid) to authenticated;

-- ── list receipts with their applied / unapplied split ───────────────────────────
create or replace function list_customer_receipts(p_customer_id uuid default null)
returns table(
  receipt_id uuid,
  customer_id uuid,
  customer_name text,
  receipt_date date,
  amount numeric,
  applied numeric,
  unapplied numeric,
  application_count int,
  method text,
  reference text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.id,
    r.customer_id,
    c.name,
    r.receipt_date,
    r.amount,
    coalesce(p.applied, 0)                as applied,
    r.amount - coalesce(p.applied, 0)     as unapplied,
    coalesce(p.n, 0)::int                  as application_count,
    r.method,
    r.reference
  from customer_receipts r
  join customers c on c.id = r.customer_id
  left join lateral (
    select sum(amount) as applied, count(*) as n
    from invoice_payments ip where ip.receipt_id = r.id
  ) p on true
  where (p_customer_id is null or r.customer_id = p_customer_id)
  order by r.receipt_date desc, r.recorded_at desc;
$$;
revoke execute on function list_customer_receipts(uuid) from public;
grant  execute on function list_customer_receipts(uuid) to authenticated;

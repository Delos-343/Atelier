-- 0033_due_date_aging.sql  (Payment terms, invoice due dates, and due-date aging)
--
-- Until now aging ran from the issue date, because invoices had no due date. This adds
-- payment terms (net days) to the customer, stamps a due date onto every invoice at
-- issuance (issue date + the customer's terms, frozen like the rest of the snapshot),
-- and re-buckets aging by that due date so the report shows what is genuinely overdue.
--
-- The anchor moves from issue date to due date in one place — receivables_aging() —
-- and invoice_receivables() (the single derivation) gains due_date and an `overdue`
-- flag, so the register and the order page can flag late invoices too. Both additions
-- are columns, so every consumer that reads by name keeps working; invoices issued
-- before this migration carry a null due date and fall back to their issue date.

-- ── the customer's default terms ─────────────────────────────────────────────────
alter table customers
  add column if not exists payment_terms_days int not null default 30 check (payment_terms_days >= 0);

-- ── the due date frozen onto an issued invoice ───────────────────────────────────
alter table issued_documents
  add column if not exists due_date date;

-- ── invoice_document(): carry the customer's terms into the snapshot ─────────────
-- (Same return type, so a plain replace; the builder feeds paymentTermsDays into the
-- snapshot, and issue_document() turns it into a concrete dueDate at filing.)
create or replace function invoice_document(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'kind', 'invoice',
    'number', so.code,
    'date', so.order_date,
    'status', so.status,
    'paymentTermsDays', c.payment_terms_days,
    'dueDate', (so.order_date + c.payment_terms_days),
    'customer', jsonb_build_object(
      'code', c.code, 'name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address),
    'warehouse', case when w.id is null then null
                      else jsonb_build_object('code', w.code, 'name', w.name) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'name', p.name,
               'quantity', sol.quantity, 'unit', sol.unit,
               'unitPrice', sol.unit_price,
               'lineTotal', sol.unit_price * sol.quantity)
             order by p.sku)
      from sales_order_lines sol
      join products p on p.id = sol.product_id
      where sol.sales_order_id = so.id), '[]'::jsonb),
    'total', coalesce(
      (select sum(sol.unit_price * sol.quantity)
         from sales_order_lines sol where sol.sales_order_id = so.id), 0)
  )
  from sales_orders so
  join customers c on c.id = so.customer_id
  left join warehouses w on w.id = so.warehouse_id
  where so.id = p_order_id;
$$;

-- ── issue_document(): stamp the due date for invoices (issue date + terms) ────────
create or replace function issue_document(
  p_kind text,
  p_order_id uuid default null,
  p_credit_note_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
  v_order_id uuid;
  v_number   text;
  v_due_date date;
  v_id       uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may issue documents'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'invoice' then
    if p_order_id is null then
      raise exception 'an order id is required to issue an invoice' using errcode = 'P0001';
    end if;
    v_snapshot := invoice_document(p_order_id);
    v_order_id := p_order_id;
  elsif p_kind = 'packing_slip' then
    if p_order_id is null then
      raise exception 'an order id is required to issue a packing slip' using errcode = 'P0001';
    end if;
    v_snapshot := packing_slip_document(p_order_id);
    v_order_id := p_order_id;
  elsif p_kind = 'credit_note' then
    if p_credit_note_id is null then
      raise exception 'a credit note id is required to issue a credit note' using errcode = 'P0001';
    end if;
    v_snapshot := credit_note_document(p_credit_note_id);
    select sales_order_id into v_order_id from credit_notes where id = p_credit_note_id;
  else
    raise exception 'unknown document kind %', p_kind using errcode = 'P0001';
  end if;

  if v_snapshot is null then
    raise exception 'document source not found' using errcode = 'P0002';
  end if;

  v_number := next_document_number(p_kind);
  if p_kind = 'credit_note' then
    v_snapshot := jsonb_set(v_snapshot, '{sourceCode}', v_snapshot->'number', true);
  else
    v_snapshot := jsonb_set(v_snapshot, '{orderCode}', v_snapshot->'number', true);
  end if;
  v_snapshot := jsonb_set(v_snapshot, '{number}', to_jsonb(v_number));

  -- Terms run from the invoice (issue) date; the due date is frozen alongside the
  -- rest of the snapshot so a later change to the customer's terms never moves it.
  if p_kind = 'invoice' then
    v_due_date := current_date + coalesce((v_snapshot->>'paymentTermsDays')::int, 0);
    v_snapshot := jsonb_set(v_snapshot, '{dueDate}', to_jsonb(v_due_date));
  end if;

  insert into issued_documents(
    kind, sales_order_id, credit_note_id, document_number, snapshot, total, due_date, issued_by)
  values (
    p_kind,
    v_order_id,
    case when p_kind = 'credit_note' then p_credit_note_id else null end,
    v_number,
    v_snapshot,
    case when v_snapshot ? 'total'
         then round((v_snapshot->>'total')::numeric, 2)
         else null end,
    v_due_date,
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ── invoice_receivables(): carry the due date and an overdue flag ────────────────
-- The return signature gains due_date and overdue, so the old function is dropped
-- first. Callers resolve it at run time; the register, documents register, and aging
-- are unaffected by the drop and pick up the new columns by name.
drop function if exists invoice_receivables(uuid);
create or replace function invoice_receivables(p_order_id uuid default null)
returns table(
  issued_document_id uuid,
  document_number text,
  sales_order_id uuid,
  order_code text,
  customer_name text,
  issued_at timestamptz,
  due_date date,
  total numeric,
  paid numeric,
  allocated numeric,
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
    d.id,
    d.document_number,
    d.sales_order_id,
    so.code,
    c.name,
    d.issued_at,
    d.due_date,
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
    (
      d.voided_at is null
      and d.due_date is not null
      and d.due_date < current_date
      and d.total - coalesce(p.paid, 0) - coalesce(a.allocated, 0) > 0
    )                                                           as overdue,
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

-- ── receivables_aging(): bucket by due date (days past due) ──────────────────────
-- Current = not yet due; then 1–30 / 31–60 / 61–90 / 90+ days overdue. Invoices with
-- no due date (issued before this migration) fall back to their issue date, so their
-- aging is unchanged. The return signature changes, so drop first.
drop function if exists receivables_aging(date);
create or replace function receivables_aging(p_as_of date default current_date)
returns table(
  customer_id uuid,
  customer_name text,
  issued_document_id uuid,
  document_number text,
  issued_at timestamptz,
  due_date date,
  days_overdue int,
  bucket text,            -- 'current' (not due) | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'
  total numeric,
  paid numeric,
  open numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    so.customer_id,
    r.customer_name,
    r.issued_document_id,
    r.document_number,
    r.issued_at,
    coalesce(r.due_date, r.issued_at::date)               as due_date,
    (p_as_of - coalesce(r.due_date, r.issued_at::date))   as days_overdue,
    case
      when (p_as_of - coalesce(r.due_date, r.issued_at::date)) <= 0  then 'current'
      when (p_as_of - coalesce(r.due_date, r.issued_at::date)) <= 30 then 'd1_30'
      when (p_as_of - coalesce(r.due_date, r.issued_at::date)) <= 60 then 'd31_60'
      when (p_as_of - coalesce(r.due_date, r.issued_at::date)) <= 90 then 'd61_90'
      else 'd90_plus'
    end                                                   as bucket,
    r.total,
    r.paid,
    r.open
  from invoice_receivables() r
  join sales_orders so on so.id = r.sales_order_id
  where r.status in ('open', 'partially_paid')   -- exclude paid and voided
    and r.open > 0
  order by r.customer_name, coalesce(r.due_date, r.issued_at::date);
$$;
revoke execute on function receivables_aging(date) from public;
grant  execute on function receivables_aging(date) to authenticated;

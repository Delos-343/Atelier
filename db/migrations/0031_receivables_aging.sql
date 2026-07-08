-- 0031_receivables_aging.sql  (Receivables aging — outstanding balances bucketed by age)
--
-- A lens on the receivables the previous slice derives: every invoice that still
-- carries an open balance, aged by how long it has been outstanding and sorted into
-- the standard buckets, so the money owed can be read by age and per customer.
--
-- It REUSES invoice_receivables() rather than recomputing open balances — it selects
-- the open and partially-paid rows from that single derivation and only adds the age
-- and bucket — so the aging report and the receivables register cannot disagree about
-- what is owed. Aging is measured from the issue date (this system has no payment
-- terms / due dates yet; due-date aging is a later refinement). p_as_of parameterizes
-- "today" for testability, exactly as the halal functions' as_of does.
--
-- Read-only and additive: no schema changes. SECURITY DEFINER, execute granted to
-- authenticated (it exposes nothing past what each signed-in user's RLS already reads);
-- the aging API route additionally requires admin.

-- 0033 re-buckets this by due date, widening the return signature by dropping and
-- recreating it. As migrations re-apply in order, this definition drops first too, so
-- a re-run does not fail on create-or-replace against the wider live signature.
drop function if exists receivables_aging(date);
create or replace function receivables_aging(p_as_of date default current_date)
returns table(
  customer_id uuid,
  customer_name text,
  issued_document_id uuid,
  document_number text,
  issued_at timestamptz,
  age_days int,
  bucket text,            -- 'current' (0–30) | 'd31_60' | 'd61_90' | 'd90_plus'
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
    (p_as_of - r.issued_at::date)          as age_days,
    case
      when (p_as_of - r.issued_at::date) <= 30 then 'current'
      when (p_as_of - r.issued_at::date) <= 60 then 'd31_60'
      when (p_as_of - r.issued_at::date) <= 90 then 'd61_90'
      else 'd90_plus'
    end                                     as bucket,
    r.total,
    r.paid,
    r.open
  from invoice_receivables() r
  join sales_orders so on so.id = r.sales_order_id
  where r.status in ('open', 'partially_paid')   -- exclude paid and voided
    and r.open > 0
  order by r.customer_name, r.issued_at;
$$;
revoke execute on function receivables_aging(date) from public;
grant  execute on function receivables_aging(date) to authenticated;

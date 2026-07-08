-- 0043_supplier_ledger.sql  (Supplier statement as a running account)
--
-- The AP counterpart to customer_ledger: what's owed to a vendor, as one dated ledger with
-- a balance carried down each line. The customer side folds four sources (invoices, credit
-- notes, receipts, direct payments); the payables side is simpler — a supplier's account
-- moves on just two things, the bills raised against them and the payments made. A bill
-- raises what we owe (debit); a payment lowers it (credit). Opening balance nets everything
-- before the window; voided bills never participate (and a voided bill carries no payments,
-- since voiding is refused while any remain). Same shape and running-balance mechanics as
-- customer_ledger, so the Supplier statement screen and its PDF reuse the same rendering.

create or replace function supplier_ledger(p_supplier_id uuid, p_start date, p_end date)
returns table(
  entry_date date,
  entry_type text,   -- 'opening' | 'bill' | 'payment'
  reference  text,
  debit      numeric,
  credit     numeric,
  balance    numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with tx as (
    select b.bill_date as entry_date, 0 as rnk, 'bill'::text as entry_type,
           b.bill_number as reference, b.amount as amt
      from bills b
     where b.supplier_id = p_supplier_id and b.voided_at is null
    union all
    select p.paid_date, 1, 'payment',
           coalesce(nullif(btrim(p.reference), ''), nullif(btrim(p.method), ''), 'Payment'),
           -p.amount
      from bill_payments p
      join bills b on b.id = p.bill_id
     where b.supplier_id = p_supplier_id and b.voided_at is null
  ),
  opening as (
    select coalesce(sum(amt), 0) as bal from tx where entry_date < p_start
  ),
  period as (
    select entry_date, rnk, entry_type, reference, amt,
           (select bal from opening)
             + sum(amt) over (order by entry_date, rnk, reference
                              rows between unbounded preceding and current row) as balance
      from tx
     where entry_date between p_start and p_end
  )
  select entry_date, entry_type, reference, debit, credit, balance
  from (
    select p_start as entry_date, -1 as rnk, 'opening'::text as entry_type,
           null::text as reference, null::numeric as debit, null::numeric as credit,
           (select bal from opening) as balance
    union all
    select entry_date, rnk, entry_type, reference,
           case when amt > 0 then amt end,
           case when amt < 0 then -amt end,
           balance
      from period
  ) x
  order by entry_date, rnk, reference nulls first;
$$;
revoke execute on function supplier_ledger(uuid, date, date) from public;
grant  execute on function supplier_ledger(uuid, date, date) to authenticated;

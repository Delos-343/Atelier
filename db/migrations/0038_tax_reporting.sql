-- 0038_tax_reporting.sql  (Tax reporting — output-vs-input PPN over a period)
--
-- The number owed to the tax office, falling straight out of the ledger. Nothing new is
-- computed here — every figure was frozen when it happened. Output PPN is the tax stamped
-- onto each issued invoice's snapshot at filing (v0.40); input PPN is the tax entered on
-- each bill (v0.43). tax_report sums each side over a date window and nets them: a
-- positive result is payable to the tax office, a negative one is a credit to carry.
--
-- Scope notes, so the figures are read correctly:
--   • Output tax counts issued invoices only — the ones that carry a taxAmount. Invoices
--     issued before the tax era have no taxAmount and are excluded (they bore no PPN), and
--     voided invoices drop out. Credit notes are untaxed in this system, so they neither
--     add nor reverse output tax.
--   • A tax-exempt customer's invoice carries a zero taxAmount, so it adds nothing to the
--     tax but its discounted value still appears in the taxable-sales base.
--   • Output is dated by issue date, input by bill date — each on the ledger it belongs to.

create or replace function tax_report(p_start date, p_end date)
returns table(
  period_start   date,
  period_end     date,
  output_tax     numeric,   -- PPN charged on issued invoices (PPN keluaran)
  taxable_sales  numeric,   -- the discounted sales value tax was computed on
  invoice_count  int,
  input_tax      numeric,   -- PPN paid on bills (PPN masukan)
  taxable_purchases numeric, -- bill value net of its tax
  bill_count     int,
  net_payable    numeric    -- output − input; positive is owed, negative is a credit
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with o as (
    select
      coalesce(sum((snapshot->>'taxAmount')::numeric), 0)     as tax,
      coalesce(sum((snapshot->>'taxableAmount')::numeric), 0) as base,
      count(*)::int                                           as n
    from issued_documents
    where kind = 'invoice'
      and voided_at is null
      and (snapshot ? 'taxAmount')
      and issued_at::date between p_start and p_end
  ),
  i as (
    select
      coalesce(sum(tax_amount), 0)          as tax,
      coalesce(sum(amount - tax_amount), 0) as base,
      count(*)::int                         as n
    from bills
    where voided_at is null
      and bill_date between p_start and p_end
  )
  select
    p_start, p_end,
    o.tax, o.base, o.n,
    i.tax, i.base, i.n,
    o.tax - i.tax
  from o, i;
$$;
revoke execute on function tax_report(date, date) from public;
grant  execute on function tax_report(date, date) to authenticated;

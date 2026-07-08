-- 0044_party_tax_id.sql  (NPWP / tax ID on customers and suppliers)
--
-- A counterparty's NPWP (Indonesian tax ID) captured on the party record, so the Faktur
-- Pajak line list can carry it — the one field that turns the reconciliation-grade export
-- into something close to an e-Faktur import. Optional free text (formats vary: the 15-digit
-- NPWP, the dotted 00.000.000.0-000.000 form, or the newer 16-digit NIK-based identifier),
-- validated only for length; a blank means "not on file" and the faktur line simply omits it.
--
-- tax_report_lines is redefined here (not edited into 0040) to add party_tax_id, because it
-- now reads customers.tax_id / suppliers.tax_id, which don't exist until the alters below.
-- The return type changes, so the old signature is dropped first for a clean replace.

alter table customers add column if not exists tax_id text;
alter table suppliers add column if not exists tax_id text;

drop function if exists tax_report_lines(date, date);
create or replace function tax_report_lines(p_start date, p_end date)
returns table(
  side            text,     -- 'output' (sales) | 'input' (purchases)
  document_number text,
  doc_date        date,
  party_code      text,
  party_name      text,
  party_tax_id    text,     -- the counterparty's NPWP, null when not on file
  taxable_base    numeric,
  tax_amount      numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    'output'::text,
    d.document_number,
    d.issued_at::date,
    c.code,
    c.name,
    c.tax_id,
    round((d.snapshot->>'taxableAmount')::numeric, 2),
    round((d.snapshot->>'taxAmount')::numeric, 2)
  from issued_documents d
  join sales_orders so on so.id = d.sales_order_id
  join customers c on c.id = so.customer_id
  where d.kind = 'invoice'
    and d.voided_at is null
    and (d.snapshot ? 'taxAmount')
    and d.issued_at::date between p_start and p_end
  union all
  select
    'input'::text,
    b.bill_number,
    b.bill_date,
    s.code,
    s.name,
    s.tax_id,
    round(b.amount - b.tax_amount, 2),
    round(b.tax_amount, 2)
  from bills b
  join suppliers s on s.id = b.supplier_id
  where b.voided_at is null
    and b.bill_date between p_start and p_end
  order by 1 desc, 3, 2;   -- 'output' before 'input' (o > i, so desc), then by date, then number
$$;
revoke execute on function tax_report_lines(date, date) from public;
grant  execute on function tax_report_lines(date, date) to authenticated;

-- 0040_tax_report_lines.sql  (PPN filing export — the Faktur Pajak line list)
--
-- The per-document detail behind tax_report's netted totals: every taxed sales invoice
-- (Faktur Pajak Keluaran) and every purchase bill (Faktur Pajak Masukan) inside a period,
-- each with its taxable base and PPN. The filters mirror tax_report exactly — an invoice
-- with a frozen taxAmount, a non-voided bill in the window — so the lines sum straight
-- back to the summary: Σ output tax = output_tax and Σ base = taxable_sales on the sales
-- side, Σ input tax = input_tax and Σ base = taxable_purchases on the purchases side. The
-- list is a faithful decomposition of the report, ready to hand off or re-key into a
-- filing. (Zero-rated lines — an exempt sale, an untaxed bill — appear at 0 PPN so the
-- document counts reconcile too; they carry no faktur of their own but belong in the
-- period's return.)

-- The return type gained party_tax_id in 0044 (NPWP on the faktur line); drop the prior
-- signature first so this create-or-replace can't collide with the widened version when
-- the migration set is re-applied statelessly (0040 runs before 0044 each pass).
drop function if exists tax_report_lines(date, date);
create or replace function tax_report_lines(p_start date, p_end date)
returns table(
  side            text,     -- 'output' (sales) | 'input' (purchases)
  document_number text,
  doc_date        date,
  party_code      text,
  party_name      text,
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

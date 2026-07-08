-- 0035_tax_pricing.sql  (VAT/PPN on invoices + per-customer price handling)
--
-- Invoices gain a proper money breakdown: subtotal → per-customer discount → taxable
-- base → PPN → total. The rate lives in one place (a tax_settings singleton, mirroring
-- costing_settings); a customer can be zero-rated (tax_exempt, e.g. export) and can
-- carry a standing discount. Everything is computed in invoice_document() and frozen
-- into the issued snapshot exactly like the line prices and the due date — so an issued
-- invoice keeps the rate and discount that applied the day it was cut, and the tax-
-- inclusive total flows straight into issued_documents.total, which invoice_receivables()
-- already reads. No downstream change is needed for receivables to carry the tax.

-- ── tax_settings: the house PPN rate (one row, like costing_settings) ─────────────
create table if not exists tax_settings (
  id         boolean primary key default true check (id),          -- one row only
  ppn_rate   numeric(5, 2) not null default 11.00 check (ppn_rate >= 0 and ppn_rate <= 100),
  updated_at timestamptz not null default now()
);
insert into tax_settings (id) values (true) on conflict (id) do nothing;

comment on column tax_settings.ppn_rate is
  'Default VAT/PPN rate as a percentage (e.g. 11.00 = 11%). Applied to every taxable customer.';

alter table tax_settings enable row level security;
-- Readable by any signed-in user (invoices need it); writable by admins only — the same
-- posture as costing_settings.
grant select, insert, update, delete on tax_settings to authenticated;
drop policy if exists tax_settings_select on tax_settings;
create policy tax_settings_select on tax_settings
  for select to authenticated using (auth.uid() is not null);
drop policy if exists tax_settings_write on tax_settings;
create policy tax_settings_write on tax_settings
  for all to authenticated
  using (current_app_role() = 'admin')
  with check (current_app_role() = 'admin');

-- ── per-customer tax treatment and standing discount ─────────────────────────────
alter table customers add column if not exists tax_exempt boolean not null default false;
alter table customers add column if not exists discount_pct numeric(5, 2) not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_discount_pct_range') then
    alter table customers
      add constraint customers_discount_pct_range check (discount_pct >= 0 and discount_pct <= 100);
  end if;
end $$;

comment on column customers.tax_exempt is 'Zero-rated (e.g. export); PPN is 0 regardless of the house rate.';
comment on column customers.discount_pct is 'Standing discount applied to the invoice subtotal before tax.';

-- ── invoice_document(): the money breakdown ──────────────────────────────────────
-- Return type is unchanged (jsonb), so create-or-replace is safe on re-migration. The
-- lateral subquery computes subtotal → discount → taxable → rate → tax in one place,
-- referencing the order's customer for the discount and exemption and the singleton for
-- the rate. The rate/discount here are the LIVE values (for the order-page preview);
-- issue_document() freezes this whole object, so an issued invoice keeps them.
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
    'subtotal', money.subtotal,
    'discountPct', coalesce(c.discount_pct, 0),
    'discountAmount', money.discount_amount,
    'taxableAmount', money.taxable,
    'taxRate', money.tax_rate,
    'taxAmount', money.tax_amount,
    'total', money.taxable + money.tax_amount
  )
  from sales_orders so
  join customers c on c.id = so.customer_id
  left join warehouses w on w.id = so.warehouse_id
  cross join lateral (
    select
      base.subtotal,
      base.discount_amount,
      base.taxable,
      base.tax_rate,
      round(base.taxable * base.tax_rate / 100.0, 2) as tax_amount
    from (
      select
        s.subtotal,
        round(s.subtotal * coalesce(c.discount_pct, 0) / 100.0, 2) as discount_amount,
        s.subtotal - round(s.subtotal * coalesce(c.discount_pct, 0) / 100.0, 2) as taxable,
        case when c.tax_exempt then 0
             else coalesce((select ppn_rate from tax_settings where id = true), 0) end as tax_rate
      from (
        select round(coalesce(sum(sol.unit_price * sol.quantity), 0), 2) as subtotal
        from sales_order_lines sol
        where sol.sales_order_id = so.id
      ) s
    ) base
  ) money
  where so.id = p_order_id;
$$;
revoke execute on function invoice_document(uuid) from public;
grant  execute on function invoice_document(uuid) to authenticated;

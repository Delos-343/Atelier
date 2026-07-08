-- 0024_document_views.sql  (Printable documents — invoice / packing slip / credit note)
--
-- Read-only document builders over existing sales + returns data. Each returns one
-- jsonb object (header + party + lines [+ total]) ready for a print view; null when the
-- id doesn't exist, which the API surfaces as a 404. No cost/unit_cost is touched — these
-- are customer-facing billing/dispatch documents — so they read the base tables directly
-- rather than the costed view, and run SECURITY INVOKER under the caller's RLS (the API
-- route additionally requires admin). Numbers are emitted as jsonb numbers so the client
-- gets real numbers, not strings.

-- ── invoice: bill the ordered quantities at their unit price ──────────────────
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
revoke execute on function invoice_document(uuid) from public;
grant  execute on function invoice_document(uuid) to authenticated;

-- ── packing slip: ordered vs shipped per line, no prices ─────────────────────
create or replace function packing_slip_document(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'kind', 'packing-slip',
    'number', so.code,
    'date', so.order_date,
    'status', so.status,
    'customer', jsonb_build_object(
      'code', c.code, 'name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address),
    'warehouse', case when w.id is null then null
                      else jsonb_build_object('code', w.code, 'name', w.name) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'name', p.name,
               'ordered', sol.quantity, 'shipped', sol.shipped_quantity, 'unit', sol.unit)
             order by p.sku)
      from sales_order_lines sol
      join products p on p.id = sol.product_id
      where sol.sales_order_id = so.id), '[]'::jsonb)
  )
  from sales_orders so
  join customers c on c.id = so.customer_id
  left join warehouses w on w.id = so.warehouse_id
  where so.id = p_order_id;
$$;
revoke execute on function packing_slip_document(uuid) from public;
grant  execute on function packing_slip_document(uuid) to authenticated;

-- ── credit note: refunded lines at their unit price, with the source order ────
create or replace function credit_note_document(p_credit_note_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'kind', 'credit-note',
    'number', cn.code,
    'date', cn.credit_date,
    'orderCode', so.code,
    'customer', jsonb_build_object(
      'code', c.code, 'name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'name', p.name,
               'quantity', cnl.quantity, 'unit', cnl.unit,
               'unitPrice', cnl.unit_price,
               'lineTotal', cnl.unit_price * cnl.quantity)
             order by p.sku)
      from credit_note_lines cnl
      join products p on p.id = cnl.product_id
      where cnl.credit_note_id = cn.id), '[]'::jsonb),
    'total', coalesce(
      (select sum(cnl.unit_price * cnl.quantity)
         from credit_note_lines cnl where cnl.credit_note_id = cn.id), 0)
  )
  from credit_notes cn
  join sales_orders so on so.id = cn.sales_order_id
  join customers c on c.id = so.customer_id
  where cn.id = p_credit_note_id;
$$;
revoke execute on function credit_note_document(uuid) from public;
grant  execute on function credit_note_document(uuid) to authenticated;

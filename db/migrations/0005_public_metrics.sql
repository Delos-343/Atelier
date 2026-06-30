-- 0005_public_metrics.sql
-- A single SECURITY DEFINER function exposing ONLY non-sensitive operational
-- aggregates to anonymous visitors for the public dashboard. It deliberately
-- exposes counts and rates — never formula compositions, costs, or quantities,
-- which remain locked to authenticated roles by RLS. Granted to anon so the
-- public page can read it without any table-level SELECT grant.

create or replace function public_metrics()
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'lots_total',          (select count(*) from inventory_lots),
    'lots_available',      (select count(*) from inventory_lots where status = 'available'),
    'lots_quarantine',     (select count(*) from inventory_lots where status = 'quarantine'),
    'products_total',      (select count(*) from products),
    'materials_total',     (select count(*) from raw_materials),
    'production_total',    (select count(*) from production_orders),
    'production_completed',(select count(*) from production_orders where status = 'completed'),
    'qc_pass_rate',        (
      select case
               when count(*) = 0 then null
               else round(count(*) filter (where status = 'passed')::numeric / count(*), 4)
             end
      from qc_checks
      where status in ('passed', 'failed')
    )
  );
$$;

grant execute on function public_metrics() to anon, authenticated;

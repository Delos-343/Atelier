-- 0007_dashboard.sql
-- Aggregated operational metrics for the authenticated dashboard. One
-- SECURITY DEFINER function so every signed-in role sees a consistent view of
-- counts and totals — never per-formula compositions or per-item costs, which
-- stay protected. Granted to authenticated only (NOT anon).

create or replace function dashboard_metrics()
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'inventory', json_build_object(
      'value_total', coalesce((
        select sum(l.quantity_on_hand * rm.standard_cost)
        from inventory_lots l
        join raw_materials rm on rm.id = l.raw_material_id
        where l.item_type = 'raw'
      ), 0),
      'lots_by_status', (
        select coalesce(json_object_agg(status, c), '{}'::json)
        from (select status::text, count(*) c from inventory_lots group by status) s
      ),
      'value_by_category', coalesce((
        select json_agg(row_to_json(t))
        from (
          select rm.category::text as category,
                 sum(l.quantity_on_hand * rm.standard_cost) as value
          from inventory_lots l
          join raw_materials rm on rm.id = l.raw_material_id
          where l.item_type = 'raw'
          group by rm.category
          order by value desc
        ) t
      ), '[]'::json)
    ),
    'production', json_build_object(
      'by_status', (
        select coalesce(json_object_agg(status, c), '{}'::json)
        from (select status::text, count(*) c from production_orders group by status) s
      ),
      'total', (select count(*) from production_orders)
    ),
    'qc', json_build_object(
      'passed', (select count(*) from qc_checks where status = 'passed'),
      'failed', (select count(*) from qc_checks where status = 'failed'),
      'pending', (select count(*) from qc_checks where status = 'pending'),
      'pass_rate', (
        select case
                 when count(*) filter (where status in ('passed', 'failed')) = 0 then null
                 else round(
                   count(*) filter (where status = 'passed')::numeric
                   / count(*) filter (where status in ('passed', 'failed')),
                   4)
               end
        from qc_checks
      )
    )
  );
$$;

grant execute on function dashboard_metrics() to authenticated;

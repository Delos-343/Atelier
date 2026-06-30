-- =====================================================================
-- 0003_security.sql — RBAC + Row-Level Security
--
-- Model:
--   * app_users maps an auth user -> role (admin | production | qc | viewer).
--   * RLS is enabled on every table. Reads require an authenticated user;
--     writes are role-gated.
--   * The inventory ledger (inventory_lots, stock_movements, lot_genealogy,
--     production_consumptions) has NO write policy on purpose — it can only be
--     mutated through the SECURITY DEFINER functions, which become the single
--     audited gateway for stock changes.
--   * Formula tables are readable only by admin/production/qc (trade secrets).
--
-- NOTE: On Supabase, roles `authenticated`/`anon` and `auth.uid()` are built in.
--       For local Postgres, see db/__tests__/_setup_local_auth.sql.
-- =====================================================================

do $$ begin
  create type app_role as enum ('admin','production','qc','viewer');
exception when duplicate_object then null; end $$;

create table if not exists app_users (
  user_id     uuid primary key,            -- references auth.users(id) on Supabase
  role        app_role not null default 'viewer',
  created_at  timestamptz not null default now()
);

-- role of the current request's user (SECURITY DEFINER avoids recursive RLS on app_users)
create or replace function current_app_role()
returns app_role
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role from app_users where user_id = auth.uid()), 'viewer'::app_role);
$$;

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ---------- enable RLS everywhere ----------
do $$
declare t text;
begin
  foreach t in array array[
    'warehouses','raw_materials','products','formulas','formula_versions',
    'formula_components','inventory_lots','stock_movements','production_orders',
    'production_order_components','production_consumptions','qc_checks',
    'lot_genealogy','app_users'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

-- ---------- app_users ----------
drop policy if exists app_users_select on app_users;
create policy app_users_select on app_users for select to authenticated
  using (user_id = auth.uid() or current_app_role() = 'admin');
drop policy if exists app_users_write on app_users;
create policy app_users_write on app_users for all to authenticated
  using (current_app_role() = 'admin') with check (current_app_role() = 'admin');

-- ---------- master data: read for all authenticated, write for admin ----------
do $$
declare t text;
begin
  foreach t in array array['warehouses','raw_materials','products'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (auth.uid() is not null);$f$, t);
    execute format('drop policy if exists %1$s_write on %1$I;', t);
    execute format($f$create policy %1$s_write on %1$I for all to authenticated
                       using (current_app_role() = 'admin')
                       with check (current_app_role() = 'admin');$f$, t);
  end loop;
end $$;

-- ---------- formulas: read for admin/production/qc, write for admin ----------
do $$
declare t text;
begin
  foreach t in array array['formulas','formula_versions','formula_components'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (current_app_role() in ('admin','production','qc'));$f$, t);
    execute format('drop policy if exists %1$s_write on %1$I;', t);
    execute format($f$create policy %1$s_write on %1$I for all to authenticated
                       using (current_app_role() = 'admin')
                       with check (current_app_role() = 'admin');$f$, t);
  end loop;
end $$;

-- ---------- production orders: read all authenticated, write admin/production ----------
do $$
declare t text;
begin
  foreach t in array array['production_orders','production_order_components'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (auth.uid() is not null);$f$, t);
    execute format('drop policy if exists %1$s_write on %1$I;', t);
    execute format($f$create policy %1$s_write on %1$I for all to authenticated
                       using (current_app_role() in ('admin','production'))
                       with check (current_app_role() in ('admin','production'));$f$, t);
  end loop;
end $$;

-- ---------- qc_checks: read all authenticated; direct insert for admin/qc ----------
drop policy if exists qc_checks_select on qc_checks;
create policy qc_checks_select on qc_checks for select to authenticated
  using (auth.uid() is not null);
drop policy if exists qc_checks_insert on qc_checks;
create policy qc_checks_insert on qc_checks for insert to authenticated
  with check (current_app_role() in ('admin','qc'));

-- ---------- ledger: READ ONLY for clients; writes only via SECURITY DEFINER fns ----------
do $$
declare t text;
begin
  foreach t in array array['inventory_lots','stock_movements','lot_genealogy','production_consumptions'] loop
    execute format('drop policy if exists %1$s_select on %1$I;', t);
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
                       using (auth.uid() is not null);$f$, t);
    -- intentionally no insert/update/delete policy
  end loop;
end $$;

-- ---------- harden the gateway functions ----------
alter function convert_qty(numeric, unit_code, unit_code, numeric)
  security definer set search_path = public, pg_temp;
alter function post_movement(uuid, movement_type, numeric, unit_code, text, uuid, uuid)
  security definer set search_path = public, pg_temp;
alter function complete_production_order(uuid, text, uuid)
  security definer set search_path = public, pg_temp;
alter function record_qc(uuid, qc_status, numeric, numeric, text, uuid)
  security definer set search_path = public, pg_temp;

grant execute on function post_movement(uuid, movement_type, numeric, unit_code, text, uuid, uuid) to authenticated;
grant execute on function complete_production_order(uuid, text, uuid) to authenticated;
grant execute on function record_qc(uuid, qc_status, numeric, numeric, text, uuid) to authenticated;
grant execute on function current_app_role() to authenticated;

-- =====================================================================
-- _setup_local_auth.sql — LOCAL TEST ONLY (do not run on Supabase)
-- Emulates the Supabase-provided roles and auth.uid() so that 0003_security.sql
-- loads and RLS can be exercised against a plain PostgreSQL instance.
-- Apply order locally: 0001 -> 0002 -> _setup_local_auth -> 0003
-- =====================================================================

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;

-- auth.uid() reads the JWT subject from a GUC, mirroring Supabase semantics.
create or replace function auth.uid()
returns uuid
language sql stable as $$
  select nullif(current_setting('app.jwt_sub', true), '')::uuid;
$$;

-- Minimal emulation of auth.users so admin functions that read it (0006) load and
-- run locally. Deliberately NOT granted to authenticated — on Supabase only a
-- SECURITY DEFINER function (owned by postgres) may read it. The shim is never
-- run on Supabase, where GoTrue provides the real auth.users.
create table if not exists auth.users (
  id          uuid primary key,
  email       text,
  created_at  timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;

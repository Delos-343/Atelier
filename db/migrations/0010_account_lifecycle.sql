-- 0010_account_lifecycle.sql
-- Guard for destructive login-account deletion.
--
-- The actual auth.users deletion is performed via the Supabase Admin API
-- (service-role) inside the server route — SQL cannot delete an auth user
-- correctly (GoTrue owns password hashes, identities, sessions, etc.). This
-- function is the audited, admin-gated PRE-CHECK, run in the caller's own auth
-- context so it can enforce the rules that depend on identity and global state:
--
--   * you cannot delete your own account, and
--   * you cannot delete the last remaining admin.
--
-- It returns the target's email (for the confirmation / audit message) or raises
-- with a precise errcode (42501 forbidden / P0002 not-found / P0001 not-allowed).
--
-- Note on the last-admin branch: for *deletion* it is largely subsumed by the
-- self-guard — the only admin who can target the sole admin is that admin, which
-- the self-check already blocks — so the system always retains >= 1 admin. It is
-- kept here as defense-in-depth and for symmetry with admin_set_user_role /
-- admin_revoke_user. The route cleans up the app_users row after deletion
-- (app_users has no FK to auth.users → no cascade); without that cleanup an
-- orphaned 'admin' row would corrupt the count below.

create or replace function admin_check_user_deletable(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email      text;
  admin_count  int;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'you cannot delete your own account' using errcode = 'P0001';
  end if;

  if exists (select 1 from app_users where user_id = p_user_id and role = 'admin') then
    select count(*) into admin_count from app_users where role = 'admin';
    if admin_count <= 1 then
      raise exception 'cannot delete the last admin' using errcode = 'P0001';
    end if;
  end if;

  select email::text into v_email from auth.users where id = p_user_id;
  return v_email;
end;
$$;

revoke execute on function admin_check_user_deletable(uuid) from public;
grant execute on function admin_check_user_deletable(uuid) to authenticated;

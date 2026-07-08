-- 0006_user_admin.sql
-- Admin-only user/role administration. These SECURITY DEFINER functions read
-- auth.users (which only the definer may) and mutate app_users, each gated on
-- current_app_role() = 'admin'. A last-admin guard prevents locking everyone out.

-- Every auth user with their effective app role (default 'viewer' when unmapped).
-- Non-admins receive an empty set (the WHERE filters them out); the API also gates.
create or replace function admin_list_users()
returns table (user_id uuid, email text, role app_role, has_override boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select u.id,
         u.email::text,
         coalesce(a.role, 'viewer'::app_role) as role,
         (a.user_id is not null) as has_override,
         u.created_at
  from auth.users u
  left join app_users a on a.user_id = u.id
  where current_app_role() = 'admin'
  order by u.created_at;
$$;

-- Assign or replace a user's role. Guards: caller must be admin; target must be a
-- real auth user; the last remaining admin cannot be demoted.
create or replace function admin_set_user_role(target uuid, new_role app_role)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  admin_count int;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = target) then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  if new_role <> 'admin'
     and exists (select 1 from app_users where user_id = target and role = 'admin') then
    select count(*) into admin_count from app_users where role = 'admin';
    if admin_count <= 1 then
      raise exception 'cannot remove the last admin' using errcode = 'P0001';
    end if;
  end if;

  insert into app_users (user_id, role)
  values (target, new_role)
  on conflict (user_id) do update set role = excluded.role;
end;
$$;

-- Remove a user's explicit mapping, reverting them to the default 'viewer'.
-- Same admin gate and last-admin guard.
create or replace function admin_revoke_user(target uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  admin_count int;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;

  if exists (select 1 from app_users where user_id = target and role = 'admin') then
    select count(*) into admin_count from app_users where role = 'admin';
    if admin_count <= 1 then
      raise exception 'cannot remove the last admin' using errcode = 'P0001';
    end if;
  end if;

  delete from app_users where user_id = target;
end;
$$;

grant execute on function admin_list_users() to authenticated;
grant execute on function admin_set_user_role(uuid, app_role) to authenticated;
grant execute on function admin_revoke_user(uuid) to authenticated;

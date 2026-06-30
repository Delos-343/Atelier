-- 0009_formula_admin.sql
-- Atomic, admin-gated operations for the formula editor. Doing these in the
-- database keeps them transactional: version numbering can't race, a BOM
-- replace can't half-apply, and locking validates the percent sum server-side.
-- SECURITY DEFINER + an internal admin check; PUBLIC execute revoked (0008 style).

-- Create the next version of a formula (optionally cloning another version's components).
create or replace function admin_create_formula_version(
  p_formula_id uuid,
  p_basis formula_basis,
  p_clone_from uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next int;
  v_new uuid;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;
  if not exists (select 1 from formulas where id = p_formula_id) then
    raise exception 'formula not found' using errcode = 'P0002';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next
  from formula_versions where formula_id = p_formula_id;

  insert into formula_versions (formula_id, version_no, basis, is_locked)
  values (p_formula_id, v_next, p_basis, false)
  returning id into v_new;

  if p_clone_from is not null then
    insert into formula_components (formula_version_id, raw_material_id, quantity, unit, sequence)
    select v_new, raw_material_id, quantity, unit, sequence
    from formula_components where formula_version_id = p_clone_from;
  end if;

  return v_new;
end;
$$;

-- Replace a version's components in one shot, optionally locking it. Locking
-- requires at least one component and (for percent basis) a sum of 100 ± 0.01.
create or replace function admin_save_formula_version(
  p_vid uuid,
  p_components jsonb,
  p_lock boolean default false
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v formula_versions%rowtype;
  v_sum numeric;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;

  select * into v from formula_versions where id = p_vid for update;
  if not found then
    raise exception 'version not found' using errcode = 'P0002';
  end if;
  if v.is_locked then
    raise exception 'this version is locked and cannot be edited' using errcode = 'P0001';
  end if;

  delete from formula_components where formula_version_id = p_vid;

  insert into formula_components (formula_version_id, raw_material_id, quantity, unit, sequence)
  select p_vid,
         (c->>'raw_material_id')::uuid,
         (c->>'quantity')::numeric,
         (c->>'unit')::unit_code,
         coalesce((c->>'sequence')::int, 0)
  from jsonb_array_elements(coalesce(p_components, '[]'::jsonb)) c;

  if p_lock then
    if not exists (select 1 from formula_components where formula_version_id = p_vid) then
      raise exception 'cannot lock an empty formula' using errcode = 'check_violation';
    end if;
    if v.basis = 'percent' then
      select coalesce(sum(quantity), 0) into v_sum
      from formula_components where formula_version_id = p_vid;
      if abs(v_sum - 100) > 0.01 then
        raise exception 'percent components sum to %, expected 100', v_sum using errcode = 'check_violation';
      end if;
    end if;
    update formula_versions set is_locked = true where id = p_vid;
  end if;
end;
$$;

-- Delete an unlocked, unreferenced version (components cascade; a version used by
-- a production order is blocked by the foreign key).
create or replace function admin_delete_formula_version(p_vid uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v formula_versions%rowtype;
begin
  if current_app_role() <> 'admin' then
    raise exception 'admin clearance required' using errcode = '42501';
  end if;
  select * into v from formula_versions where id = p_vid;
  if not found then
    raise exception 'version not found' using errcode = 'P0002';
  end if;
  if v.is_locked then
    raise exception 'cannot delete a locked version' using errcode = 'P0001';
  end if;
  delete from formula_versions where id = p_vid;
end;
$$;

revoke execute on function admin_create_formula_version(uuid, formula_basis, uuid) from public;
grant  execute on function admin_create_formula_version(uuid, formula_basis, uuid) to authenticated;
revoke execute on function admin_save_formula_version(uuid, jsonb, boolean) from public;
grant  execute on function admin_save_formula_version(uuid, jsonb, boolean) to authenticated;
revoke execute on function admin_delete_formula_version(uuid) from public;
grant  execute on function admin_delete_formula_version(uuid) to authenticated;

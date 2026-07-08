-- 0018_halal_compliance.sql
-- SJPH halal compliance (BPJPH context). Halal status is recorded at the
-- material level; a formula version's verdict is *derived* from its components
-- so a product-level flag can never drift out of sync with the recipe it ships.
-- Compliance rides on input provenance (ethanol / solvent especially).

-- ---------- status enum ----------
do $$ begin
  create type halal_status as enum ('certified', 'not_certified', 'in_review');
exception when duplicate_object then null; end $$;

-- ---------- material halal columns ----------
-- Fail-closed: existing + new rows default to 'in_review' (not certified) until
-- an admin records a certificate. Cert metadata is manually entered, not verified.
alter table raw_materials
  add column if not exists halal_status      halal_status not null default 'in_review',
  add column if not exists halal_cert_number text,
  add column if not exists halal_certifier   text,
  add column if not exists halal_cert_expiry date;

-- A material may only be marked 'certified' with a certificate number and an
-- expiry on file. Existing rows default to 'in_review', so they satisfy this.
do $$ begin
  alter table raw_materials
    add constraint raw_materials_halal_cert_chk
    check (
      halal_status <> 'certified'
      or (halal_cert_number is not null and halal_cert_expiry is not null)
    );
exception when duplicate_object then null; end $$;

-- ---------- per-version non-compliance detail ----------
-- Returns one row per offending component of a formula version: any material
-- that is not certified, or certified without an expiry, or whose certificate
-- has lapsed as of p_as_of. Empty result == compliant.
create or replace function formula_version_halal_noncompliance(
  p_formula_version_id uuid,
  p_as_of date default current_date
)
returns table (
  raw_material_id   uuid,
  sku               text,
  name              text,
  halal_status      halal_status,
  halal_cert_number text,
  halal_cert_expiry date,
  reason            text
)
language sql
stable
as $$
  select distinct
    rm.id,
    rm.sku,
    rm.name,
    rm.halal_status,
    rm.halal_cert_number,
    rm.halal_cert_expiry,
    case
      when rm.halal_status = 'not_certified' then 'not certified'
      when rm.halal_status = 'in_review'     then 'in review'
      when rm.halal_cert_expiry is null      then 'certified without an expiry on file'
      when rm.halal_cert_expiry < p_as_of    then 'certificate expired'
      else 'not compliant'
    end as reason
  from formula_components fc
  join raw_materials rm on rm.id = fc.raw_material_id
  where fc.formula_version_id = p_formula_version_id
    and not (
      rm.halal_status = 'certified'
      and rm.halal_cert_expiry is not null
      and rm.halal_cert_expiry >= p_as_of
    )
  order by rm.sku;
$$;

-- ---------- per-version scalar verdict ----------
create or replace function is_formula_version_halal(
  p_formula_version_id uuid,
  p_as_of date default current_date
)
returns boolean
language sql
stable
as $$
  select not exists (
    select 1 from formula_version_halal_noncompliance(p_formula_version_id, p_as_of)
  );
$$;

-- ---------- overview across all formula versions ----------
-- One row per formula version with its compliance verdict and, when
-- non-compliant, a JSON array of the offending materials + reasons.
create or replace function formula_versions_compliance(
  p_as_of date default current_date
)
returns table (
  formula_version_id uuid,
  formula_code       text,
  formula_name       text,
  product_name       text,
  version_no         int,
  is_locked          boolean,
  compliant          boolean,
  offending          jsonb
)
language sql
stable
as $$
  select
    fv.id,
    f.code,
    f.name,
    p.name,
    fv.version_no,
    fv.is_locked,
    not exists (
      select 1 from formula_version_halal_noncompliance(fv.id, p_as_of)
    ) as compliant,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object('sku', n.sku, 'name', n.name, 'reason', n.reason)
                 order by n.sku
               )
        from formula_version_halal_noncompliance(fv.id, p_as_of) n
      ),
      '[]'::jsonb
    ) as offending
  from formula_versions fv
  join formulas f on f.id = fv.formula_id
  left join products p on p.id = f.product_id
  order by f.code, fv.version_no;
$$;

-- ---------- grants ----------
-- INVOKER functions: authenticated callers already have select on the
-- underlying tables via RLS, so running under the caller is correct.
grant execute on function formula_version_halal_noncompliance(uuid, date) to authenticated;
grant execute on function is_formula_version_halal(uuid, date) to authenticated;
grant execute on function formula_versions_compliance(date) to authenticated;

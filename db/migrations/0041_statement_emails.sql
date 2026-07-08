-- 0041_statement_emails.sql  (Statement delivery — recording emailed statements of account)
--
-- A statement of account isn't a persisted document — it's derived per period — so its
-- send history lives in its own table rather than hanging off issued_documents. A row
-- means "the mail server accepted a statement for this customer and period", written only
-- AFTER the SMTP send succeeds, so it never records an attempt that failed. Mirrors
-- document_emails: select-only for signed-in users, all writes through the admin-gated
-- SECURITY DEFINER function below.

create table if not exists statement_emails (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  recipient     text not null,
  subject       text not null,
  sent_by       uuid,                                  -- auth.uid() of the sender (no FK: auth.users is GoTrue-owned)
  sent_at       timestamptz not null default now()
);

alter table statement_emails enable row level security;

-- Written only inside record_statement_email() (SECURITY DEFINER, owner) — so no write
-- policy exists and RLS denies any direct authenticated insert/update/delete. Readable
-- by any signed-in user, like the statements it annotates.
drop policy if exists statement_emails_select on statement_emails;
create policy statement_emails_select on statement_emails
  for select to authenticated using (auth.uid() is not null);

grant select on statement_emails to authenticated;

create index if not exists statement_emails_customer_idx
  on statement_emails(customer_id, period_start, period_end, sent_at desc);

create or replace function record_statement_email(
  p_customer_id uuid,
  p_period_start date,
  p_period_end date,
  p_recipient text,
  p_subject text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- Reachable by any authenticated user via PostgREST, so the admin gate lives here too
  -- (the API route is admin-gated as well). current_app_role() reflects the real caller.
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may record a statement email'
      using errcode = 'insufficient_privilege';
  end if;

  if p_recipient is null or btrim(p_recipient) = '' then
    raise exception 'a recipient is required' using errcode = 'P0001';
  end if;

  if not exists (select 1 from customers where id = p_customer_id) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;

  insert into statement_emails(customer_id, period_start, period_end, recipient, subject, sent_by)
  values (
    p_customer_id,
    p_period_start,
    p_period_end,
    btrim(p_recipient),
    coalesce(p_subject, ''),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function record_statement_email(uuid, date, date, text, text) from public;
grant  execute on function record_statement_email(uuid, date, date, text, text) to authenticated;

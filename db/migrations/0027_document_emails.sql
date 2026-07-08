-- 0027_document_emails.sql  (Emailing an issued document — the send record)
--
-- An issued document (0026) can be emailed to the customer with the frozen PDF attached.
-- The SMTP transaction happens in the Node server (Postgres cannot send mail), so this
-- migration provides only the durable half: document_emails records each send — to whom,
-- with what subject and message, by which admin, when — against the immutable issued
-- record it carried. The server sends FIRST and records SECOND, so a row here means
-- "this email was accepted by the mail server", never "we tried". Re-sending (after a
-- bounce, or to a second address) simply adds another row; the trail is append-only.

create table if not exists document_emails (
  id                 uuid primary key default gen_random_uuid(),
  issued_document_id uuid not null references issued_documents(id) on delete cascade,
  recipient          text not null,
  subject            text not null,
  message            text not null,
  sent_by            uuid,                                  -- auth.uid() of the sender (no FK: auth.users is GoTrue-owned)
  sent_at            timestamptz not null default now()
);

alter table document_emails enable row level security;

-- Written only inside record_document_email() (SECURITY DEFINER, owner) — so no write
-- policy exists and RLS denies any direct authenticated insert/update/delete. Readable
-- by any signed-in user, like the issued-document archive it annotates.
drop policy if exists document_emails_select on document_emails;
create policy document_emails_select on document_emails
  for select to authenticated using (auth.uid() is not null);

grant select on document_emails to authenticated;

create index if not exists document_emails_doc_idx
  on document_emails(issued_document_id, sent_at desc);

-- ── record a send: append-only, admin-gated inside the function ──────────────
create or replace function record_document_email(
  p_issued_document_id uuid,
  p_recipient text,
  p_subject text,
  p_message text
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
    raise exception 'only an administrator may record a document email'
      using errcode = 'insufficient_privilege';
  end if;

  if p_recipient is null or btrim(p_recipient) = '' then
    raise exception 'a recipient is required' using errcode = 'P0001';
  end if;

  if not exists (select 1 from issued_documents where id = p_issued_document_id) then
    raise exception 'issued document not found' using errcode = 'P0002';
  end if;

  insert into document_emails(issued_document_id, recipient, subject, message, sent_by)
  values (
    p_issued_document_id,
    btrim(p_recipient),
    coalesce(p_subject, ''),
    coalesce(p_message, ''),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function record_document_email(uuid, text, text, text) from public;
grant  execute on function record_document_email(uuid, text, text, text) to authenticated;

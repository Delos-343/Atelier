-- 0026_issued_documents.sql  (Immutable issued-document archive)
--
-- Today's invoice / packing slip / credit note render from LIVE data, so a document
-- regenerated after the order changes would not match what the customer received. This
-- files an immutable snapshot against the order at issue time: issue_document() calls the
-- existing *_document() builder, freezes the returned JSON, and records who issued it and
-- when. Retrieval re-renders the PDF from the frozen snapshot (see the renderer), so an
-- issued document never drifts. Each issuance is its own record — re-issuing a corrected
-- document adds a new row rather than mutating the old one, preserving the trail.

create table if not exists issued_documents (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('invoice', 'packing_slip', 'credit_note')),
  sales_order_id   uuid not null references sales_orders(id) on delete cascade,
  credit_note_id   uuid references credit_notes(id) on delete cascade,
  document_number  text not null,
  snapshot         jsonb not null,
  issued_by        uuid,                                   -- auth.uid() of the issuer (no FK: auth.users is GoTrue-owned)
  issued_at        timestamptz not null default now()
);

-- A credit-note document carries a credit_note_id; the order-level kinds do not.
alter table issued_documents drop constraint if exists issued_documents_cn_ck;
alter table issued_documents add constraint issued_documents_cn_ck
  check ((kind = 'credit_note') = (credit_note_id is not null));

alter table issued_documents enable row level security;

-- Written only inside issue_document() (SECURITY DEFINER, owner) — so no write policy exists
-- and RLS denies any direct authenticated insert/update/delete. Readable by any signed-in user.
drop policy if exists issued_documents_select on issued_documents;
create policy issued_documents_select on issued_documents
  for select to authenticated using (auth.uid() is not null);

grant select on issued_documents to authenticated;

create index if not exists issued_documents_order_idx
  on issued_documents(sales_order_id, issued_at desc);

-- ── issue a document: snapshot the current builder output as an immutable record ──
create or replace function issue_document(
  p_kind text,
  p_order_id uuid default null,
  p_credit_note_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
  v_order_id uuid;
  v_id       uuid;
begin
  -- Reachable by any authenticated user via PostgREST, so the admin gate lives here too
  -- (the API route is admin-gated as well). current_app_role() reflects the real caller.
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may issue documents'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'invoice' then
    if p_order_id is null then
      raise exception 'an order id is required to issue an invoice' using errcode = 'P0001';
    end if;
    v_snapshot := invoice_document(p_order_id);
    v_order_id := p_order_id;
  elsif p_kind = 'packing_slip' then
    if p_order_id is null then
      raise exception 'an order id is required to issue a packing slip' using errcode = 'P0001';
    end if;
    v_snapshot := packing_slip_document(p_order_id);
    v_order_id := p_order_id;
  elsif p_kind = 'credit_note' then
    if p_credit_note_id is null then
      raise exception 'a credit note id is required to issue a credit note' using errcode = 'P0001';
    end if;
    v_snapshot := credit_note_document(p_credit_note_id);
    select sales_order_id into v_order_id from credit_notes where id = p_credit_note_id;
  else
    raise exception 'unknown document kind %', p_kind using errcode = 'P0001';
  end if;

  if v_snapshot is null then
    raise exception 'document source not found' using errcode = 'P0002';
  end if;

  insert into issued_documents(
    kind, sales_order_id, credit_note_id, document_number, snapshot, issued_by)
  values (
    p_kind,
    v_order_id,
    case when p_kind = 'credit_note' then p_credit_note_id else null end,
    v_snapshot->>'number',
    v_snapshot,
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function issue_document(text, uuid, uuid) from public;
grant  execute on function issue_document(text, uuid, uuid) to authenticated;

-- 0028_document_sequences.sql  (Numbered document sequences)
--
-- Until now an issued document's number was the ORDER code — so issuing the same
-- invoice twice filed two records under one number, and an invoice, its packing slip,
-- and the order all shared an identifier. Real documents need their own series. This
-- gives each kind a dedicated, year-scoped sequence (INV-2026-00001, PS-2026-00001,
-- CN-2026-00001), assigned inside issue_document() at the moment of filing.
--
-- The counter is a plain row taken UNDER A ROW LOCK in the issuing transaction
-- (insert .. on conflict do update .. returning), NOT a Postgres SEQUENCE — a
-- deliberate trade. A SEQUENCE is non-transactional: a rolled-back issuance would
-- burn a number and leave a gap. The locked row is transactional — concurrent
-- issuances serialize on it (fine at document volume; this codebase already buys
-- correctness with row locks in post_movement) and a rollback returns its number,
-- so the series is GAPLESS by construction. Uniqueness needs no index: numbers are
-- handed out single-file. Rows issued before this migration keep their order-code
-- numbers; the new series applies from here on.
--
-- The assigned number is written both to issued_documents.document_number and INTO
-- the frozen snapshot itself (its `number` field), keeping the snapshot the single
-- self-contained artifact the PDF renders from — "document_number = snapshot number"
-- stays true. The identifier the number replaces is preserved in the snapshot: the
-- order code moves to `orderCode` on an invoice / packing slip, and a credit note's
-- manually entered code moves to `sourceCode` (its `orderCode` already names the
-- source order). The PDF letterhead gains matching reference lines.

create table if not exists document_sequences (
  kind        text   not null,
  year        int    not null,
  next_value  bigint not null default 1,
  primary key (kind, year)
);

-- Internal machinery: no reads, no writes from clients — RLS enabled with NO policy
-- denies everything; only the SECURITY DEFINER issue path (running as the owner)
-- touches it. Same posture as the _create_lot primitive.
alter table document_sequences enable row level security;
-- Defense in depth AND idempotency: the blanket grant in 0003 hands `authenticated`
-- table privileges on every table that exists when it runs. On a fresh migration this
-- table doesn't exist yet, so it's never granted — but migrations here re-apply in
-- full, and on a re-run 0003 would re-grant it. This revoke runs after 0003 in every
-- pass, so the counter stays ungranted: unreachable by any route but the DEFINER issuer
-- (RLS-with-no-policy already denies rows; removing the grant denies access outright).
revoke all on document_sequences from authenticated;

-- ── take the next number in a series (owner-only helper) ─────────────────────
-- p_as_of parameterizes the year for testability (the halal functions' as_of
-- pattern); issue_document passes the current date.
create or replace function next_document_number(
  p_kind text,
  p_as_of date default current_date
) returns text
language plpgsql
as $$
declare
  v_year   int := extract(year from p_as_of)::int;
  v_val    bigint;
  v_prefix text;
begin
  v_prefix := case p_kind
    when 'invoice'      then 'INV'
    when 'packing_slip' then 'PS'
    when 'credit_note'  then 'CN'
    else null
  end;
  if v_prefix is null then
    raise exception 'unknown document kind %', p_kind using errcode = 'P0001';
  end if;

  -- New series row: hand out 1, park 2. Existing row: lock it, increment, hand out
  -- the pre-increment value. The lock holds until the issuing transaction ends, so
  -- a rollback returns the number to the series — gapless.
  insert into document_sequences(kind, year, next_value)
  values (p_kind, v_year, 2)
  on conflict (kind, year) do update
    set next_value = document_sequences.next_value + 1
  returning next_value - 1 into v_val;

  -- lpad TRUNCATES an over-long input; widen past 99,999 instead of corrupting.
  return format('%s-%s-%s', v_prefix, v_year,
                lpad(v_val::text, greatest(5, length(v_val::text)), '0'));
end;
$$;
revoke execute on function next_document_number(text, date) from public;
-- no grant: owner-only, reachable solely through the DEFINER issuer below.

-- ── recreate issue_document: assign the series number at filing time ──────────
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
  v_number   text;
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

  -- Assign this issuance its series number, preserving the identifier it replaces:
  -- the order code (invoice / packing slip) or the manually entered credit-note code.
  v_number := next_document_number(p_kind);
  if p_kind = 'credit_note' then
    v_snapshot := jsonb_set(v_snapshot, '{sourceCode}', v_snapshot->'number', true);
  else
    v_snapshot := jsonb_set(v_snapshot, '{orderCode}', v_snapshot->'number', true);
  end if;
  v_snapshot := jsonb_set(v_snapshot, '{number}', to_jsonb(v_number));

  insert into issued_documents(
    kind, sales_order_id, credit_note_id, document_number, snapshot, issued_by)
  values (
    p_kind,
    v_order_id,
    case when p_kind = 'credit_note' then p_credit_note_id else null end,
    v_number,
    v_snapshot,
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function issue_document(text, uuid, uuid) from public;
grant  execute on function issue_document(text, uuid, uuid) to authenticated;

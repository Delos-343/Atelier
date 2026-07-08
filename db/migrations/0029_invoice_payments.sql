-- 0029_invoice_payments.sql  (Payments against issued invoices — receivables)
--
-- The continuation of the invoice lifecycle: an issued invoice (an immutable
-- issued_documents row, kind='invoice', numbered since 0028) is a frozen CLAIM the
-- customer owes against. This migration makes the claim collectible — payments are
-- recorded against the specific issued invoice, not the order, so an order
-- re-invoiced after a correction keeps each artifact's ledger separate — and makes
-- a mis-issued document VOIDABLE (never deletable: the archive stays append-only;
-- a void is itself on the record, with a reason and a signature).
--
-- Four deliberate rules:
--
--   1. THE CLAIM IS THE PAPER FIGURE. Line prices are numeric(14,4), so a raw
--      snapshot total can carry sub-cent residue (35.4319) no customer can ever
--      remit — while every rendered document displays money at 2 dp. The
--      receivable is therefore round(snapshot total, 2): exactly what the paper
--      says. It is stamped into a `total` column at issuance (frozen data — the
--      copy cannot drift) and backfilled for documents issued before this release.
--
--   2. A PAYMENT NEVER EXCEEDS THE OPEN BALANCE. Recording locks the invoice row
--      FOR UPDATE, so concurrent payments (and voids) serialize and the balance
--      check is race-free — the same row-lock-buys-correctness trade as
--      post_movement and the 0028 sequence counter. Over-payment / customer
--      credit is a deliberate non-feature, mirroring how over-returns raise.
--
--   3. MONEY RECORDS RESTRICT, NEVER CASCADE. document_emails vanish with their
--      document; a payment blocks deletion of its invoice. Correcting a
--      hand-keyed mistake is an explicit admin action (delete_invoice_payment):
--      payments are operational records, not yet a double-entry ledger — a ledger
--      slice would replace deletion with reversing entries.
--
--   4. DERIVED STATE IS COMPUTED ON READ, IN ONE PLACE. invoice_receivables()
--      derives paid / open / status from the payment rows for both the order page
--      and the receivables register — like the halal verdict, it can never drift
--      from the facts underneath it, and no second derivation lives in TypeScript.

alter table issued_documents
  add column if not exists total       numeric,      -- the monetary claim at 2 dp; null for packing slips
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid,
  add column if not exists void_reason text;

update issued_documents
   set total = round((snapshot->>'total')::numeric, 2)
 where total is null
   and snapshot ? 'total';

-- The draft shape of this table (a prior work-in-progress: amount numeric(18,6),
-- paid_date default-only, on delete cascade) may exist in a database that ran an
-- earlier copy of this file. It never shipped in a release and holds no real data;
-- rebuild it in its final shape.
drop table if exists invoice_payments;

create table invoice_payments (
  id                 uuid primary key default gen_random_uuid(),
  issued_document_id uuid not null references issued_documents(id) on delete restrict,
  amount             numeric(14,2) not null check (amount > 0),
  paid_date          date not null default current_date,
  method             text,                                  -- free text: bank transfer, QRIS, cash, …
  reference          text,                                  -- transfer / remittance reference
  recorded_by        uuid,                                  -- auth.uid() (no FK: auth.users is GoTrue-owned)
  recorded_at        timestamptz not null default now()
);

alter table invoice_payments enable row level security;

-- Written only inside the DEFINER functions below — no write policy exists, so RLS
-- denies any direct authenticated write. Readable by any signed-in user, like the
-- archive it settles.
drop policy if exists invoice_payments_select on invoice_payments;
create policy invoice_payments_select on invoice_payments
  for select to authenticated using (auth.uid() is not null);

grant select on invoice_payments to authenticated;

create index if not exists invoice_payments_doc_idx
  on invoice_payments(issued_document_id, paid_date desc);

-- ── record a payment: locked, never past the claim, never on a void ──────────
create or replace function record_invoice_payment(
  p_issued_document_id uuid,
  p_amount numeric,
  p_paid_date date default current_date,
  p_method text default null,
  p_reference text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc  issued_documents%rowtype;
  v_paid numeric;
  v_id   uuid;
begin
  -- Reachable by any authenticated user via PostgREST, so the admin gate lives here
  -- too (the API route is admin-gated as well).
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may record payments'
      using errcode = 'insufficient_privilege';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'the payment amount must be greater than zero' using errcode = 'P0001';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'the payment amount must have at most 2 decimal places' using errcode = 'P0001';
  end if;

  -- Lock the invoice: concurrent payments and voids serialize here, so the checks
  -- below are race-free.
  select * into v_doc from issued_documents where id = p_issued_document_id for update;
  if not found then
    raise exception 'issued document not found' using errcode = 'P0002';
  end if;
  if v_doc.kind <> 'invoice' then
    raise exception 'payments are recorded against issued invoices only' using errcode = 'P0001';
  end if;
  if v_doc.voided_at is not null then
    raise exception 'this invoice is voided; no payment can be recorded against it' using errcode = 'P0001';
  end if;
  if v_doc.total is null then
    raise exception 'this invoice carries no total to pay against' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from invoice_payments
   where issued_document_id = p_issued_document_id;

  if v_paid + p_amount > v_doc.total then
    raise exception 'payment of % exceeds the open balance of % on %',
      to_char(p_amount, 'FM999999990.00'),
      to_char(v_doc.total - v_paid, 'FM999999990.00'),
      v_doc.document_number
      using errcode = 'P0001';
  end if;

  insert into invoice_payments(issued_document_id, amount, paid_date, method, reference, recorded_by)
  values (
    p_issued_document_id,
    p_amount,
    coalesce(p_paid_date, current_date),
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_reference, '')), ''),
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function record_invoice_payment(uuid, numeric, date, text, text) from public;
grant  execute on function record_invoice_payment(uuid, numeric, date, text, text) to authenticated;

-- ── correct a hand-keyed mistake ──────────────────────────────────────────────
create or replace function delete_invoice_payment(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may delete payments'
      using errcode = 'insufficient_privilege';
  end if;
  delete from invoice_payments where id = p_id;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function delete_invoice_payment(uuid) from public;
grant  execute on function delete_invoice_payment(uuid) to authenticated;

-- ── void a mis-issued document (any kind), on the record ─────────────────────
create or replace function void_issued_document(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc      issued_documents%rowtype;
  v_payments int;
begin
  if current_app_role() <> 'admin' then
    raise exception 'only an administrator may void documents'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to void a document' using errcode = 'P0001';
  end if;

  select * into v_doc from issued_documents where id = p_id for update;
  if not found then
    raise exception 'issued document not found' using errcode = 'P0002';
  end if;
  if v_doc.voided_at is not null then
    raise exception 'this document is already voided' using errcode = 'P0001';
  end if;

  select count(*) into v_payments from invoice_payments where issued_document_id = p_id;
  if v_payments > 0 then
    raise exception 'an invoice with recorded payments cannot be voided — remove its payments first or credit the customer'
      using errcode = 'P0001';
  end if;

  update issued_documents
     set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   where id = p_id;
end;
$$;
revoke execute on function void_issued_document(uuid, text) from public;
grant  execute on function void_issued_document(uuid, text) to authenticated;

-- ── per-invoice receivables state, derived on read (the single derivation) ───
-- One row per issued invoice: the frozen claim, what has been paid, what remains,
-- the derived status, and the void record. Filterable to one order (the order
-- page) or unfiltered (the receivables register). SECURITY DEFINER with execute
-- granted to authenticated only: it exposes nothing beyond what every signed-in
-- user's RLS already reads, and it must not depend on environment-specific table
-- grants (the local shim has none; Supabase's defaults differ). The API route
-- additionally requires admin.
-- Later migrations widen this function's return signature (credit allocations in
-- 0032, due dates in 0033) by dropping and recreating it. Because migrations re-apply
-- in order every run, this definition must also drop first — a plain create-or-replace
-- cannot run against the wider live signature. Callers resolve it at run time.
drop function if exists invoice_receivables(uuid);
create or replace function invoice_receivables(p_order_id uuid default null)
returns table(
  issued_document_id uuid,
  document_number text,
  sales_order_id uuid,
  order_code text,
  customer_name text,
  issued_at timestamptz,
  total numeric,
  paid numeric,
  open numeric,
  status text,
  payment_count int,
  last_paid_date date,
  void_reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.document_number,
    d.sales_order_id,
    so.code,
    c.name,
    d.issued_at,
    d.total,
    coalesce(p.paid, 0)                            as paid,
    d.total - coalesce(p.paid, 0)                  as open,
    case
      when d.voided_at is not null then 'void'
      when coalesce(p.paid, 0) <= 0 and d.total > 0 then 'open'
      when coalesce(p.paid, 0) < d.total then 'partially_paid'
      else 'paid'
    end                                            as status,
    coalesce(p.n, 0)::int                          as payment_count,
    p.last_paid                                    as last_paid_date,
    d.void_reason
  from issued_documents d
  join sales_orders so on so.id = d.sales_order_id
  join customers c on c.id = so.customer_id
  left join lateral (
    select sum(ip.amount) as paid, count(*) as n, max(ip.paid_date) as last_paid
    from invoice_payments ip
    where ip.issued_document_id = d.id
  ) p on true
  where d.kind = 'invoice'
    and (p_order_id is null or d.sales_order_id = p_order_id)
  order by d.issued_at desc;
$$;
revoke execute on function invoice_receivables(uuid) from public;
grant  execute on function invoice_receivables(uuid) to authenticated;

-- ── recreate issue_document: stamp the monetary claim at filing time ─────────
-- Identical to 0028's version plus one line: `total` is written from the snapshot
-- at currency precision (rule 1 above) so every downstream read is a plain typed
-- column, never a jsonb excursion.
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

  v_number := next_document_number(p_kind);
  if p_kind = 'credit_note' then
    v_snapshot := jsonb_set(v_snapshot, '{sourceCode}', v_snapshot->'number', true);
  else
    v_snapshot := jsonb_set(v_snapshot, '{orderCode}', v_snapshot->'number', true);
  end if;
  v_snapshot := jsonb_set(v_snapshot, '{number}', to_jsonb(v_number));

  insert into issued_documents(
    kind, sales_order_id, credit_note_id, document_number, snapshot, total, issued_by)
  values (
    p_kind,
    v_order_id,
    case when p_kind = 'credit_note' then p_credit_note_id else null end,
    v_number,
    v_snapshot,
    case when v_snapshot ? 'total'
         then round((v_snapshot->>'total')::numeric, 2)
         else null end,
    auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function issue_document(text, uuid, uuid) from public;
grant  execute on function issue_document(text, uuid, uuid) to authenticated;

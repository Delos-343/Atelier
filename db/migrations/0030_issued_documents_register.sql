-- 0030_issued_documents_register.sql  (Documents register — the issued archive's front door)
--
-- The issued_documents archive has only ever been queryable one sales order at a
-- time (the order page). This adds a single set-returning derivation over the WHOLE
-- archive — every issued invoice, packing slip, and credit note — each carrying the
-- order and customer it belongs to, its send history in summary (how many times
-- emailed, and to whom last), and, for invoices, the receivable status REUSED from
-- invoice_receivables() so the register and the order page can never disagree.
--
-- Read-only and additive: no schema changes, no new writes. SECURITY DEFINER with
-- execute granted to authenticated — it exposes nothing past what each signed-in
-- user's RLS already reads across issued_documents / sales_orders / customers /
-- document_emails; the register's API route additionally requires admin.

create or replace function issued_documents_register()
returns table(
  issued_document_id uuid,
  kind text,
  document_number text,
  sales_order_id uuid,
  order_code text,
  customer_name text,
  issued_at timestamptz,
  total numeric,
  voided boolean,
  void_reason text,
  email_count int,
  last_emailed_at timestamptz,
  last_recipient text,
  payment_status text,
  paid numeric,
  open numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.kind,
    d.document_number,
    d.sales_order_id,
    so.code,
    c.name,
    d.issued_at,
    d.total,
    d.voided_at is not null,
    d.void_reason,
    coalesce(e.n, 0)::int          as email_count,
    e.last_at                      as last_emailed_at,
    e.last_recipient,
    r.status                       as payment_status,
    r.paid,
    r.open
  from issued_documents d
  join sales_orders so on so.id = d.sales_order_id
  join customers c on c.id = so.customer_id
  -- Send summary: latest send carries the total count via the window (computed over
  -- all rows for the document before LIMIT), so one scan yields both.
  left join lateral (
    select de.recipient        as last_recipient,
           de.sent_at          as last_at,
           count(*) over ()    as n
    from document_emails de
    where de.issued_document_id = d.id
    order by de.sent_at desc
    limit 1
  ) e on true
  -- Reuse the receivable derivation rather than recomputing paid / open / status;
  -- it returns invoices only, so non-invoice kinds get a null join (no payment state).
  left join invoice_receivables() r on r.issued_document_id = d.id
  order by d.issued_at desc, d.document_number desc;
$$;
revoke execute on function issued_documents_register() from public;
grant  execute on function issued_documents_register() to authenticated;

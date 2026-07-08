-- 0045_email_history.sql  (Unified send-history view)
--
-- The two email trails the DEFINER functions record — document_emails (an issued invoice /
-- packing slip / credit note sent to a customer) and statement_emails (a statement of
-- account sent for a period) — surfaced as one chronological log an admin can actually
-- read, rather than data that only lives in the tables. A read-only union: each row is a
-- send, tagged by kind, carrying the counterparty, the recipient, the subject, and a
-- reference (the document number, or the statement's period). Read-only and SECURITY
-- DEFINER granted to authenticated, with the route gating admin — the same pattern as the
-- documents register and the aging report.

create or replace function email_history()
returns table(
  sent_at    timestamptz,
  kind       text,       -- 'document' | 'statement'
  doc_kind   text,       -- invoice / packing_slip / credit_note for documents; null for statements
  reference  text,       -- the document number, or the statement's period
  party_name text,
  recipient  text,
  subject    text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    de.sent_at, 'document'::text, d.kind, d.document_number, c.name, de.recipient, de.subject
  from document_emails de
  join issued_documents d on d.id = de.issued_document_id
  left join sales_orders so on so.id = d.sales_order_id
  left join customers c on c.id = so.customer_id
  union all
  select
    se.sent_at, 'statement'::text, null::text,
    (to_char(se.period_start, 'YYYY-MM-DD') || ' – ' || to_char(se.period_end, 'YYYY-MM-DD')),
    c.name, se.recipient, se.subject
  from statement_emails se
  join customers c on c.id = se.customer_id
  order by sent_at desc;
$$;
revoke execute on function email_history() from public;
grant  execute on function email_history() to authenticated;

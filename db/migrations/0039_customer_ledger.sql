-- 0039_customer_ledger.sql  (Customer statement as a running account)
--
-- The account the way the customer's own books read it: one dated ledger folding every
-- document that moves what they owe, with a balance carried down each line. Invoices
-- raise the balance; credit notes, cash receipts and direct payments lower it. Unlike
-- the aged statement — which lists only open invoices bucketed by age — this is a
-- balance-forward register: an opening balance (everything before the window, netted),
-- then each transaction inside the window with a running balance, ending at what's due.
--
-- Sources, all attributed to the customer the same way (issued_documents carry a
-- sales_order_id even for credit notes, and sales_orders carry the customer):
--   • invoices        issued_documents kind='invoice'      +total   (dated issued_at)
--   • credit notes    issued_documents kind='credit_note'  −total   (dated issued_at)
--   • receipts        customer_receipts (the cash lump)     −amount  (dated receipt_date)
--   • direct payments invoice_payments not tied to a receipt −amount (dated paid_date)
-- Receipt-tagged payments are left out — the receipt lump already carries them, so cash
-- is counted once at the amount the customer actually remitted. A receipt's on-account
-- remainder is therefore included in full, so a prepayment nets against the balance the
-- way the customer would expect (this can make the running balance lower than the sum of
-- open invoices, which the aged statement reports gross of any credit on account). Voided
-- invoices and credit notes are excluded; packing slips never participate.

create or replace function customer_ledger(p_customer_id uuid, p_start date, p_end date)
returns table(
  entry_date date,
  entry_type text,   -- 'opening' | 'invoice' | 'credit_note' | 'receipt' | 'payment'
  reference  text,
  debit      numeric,
  credit     numeric,
  balance    numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with tx as (
    select d.issued_at::date as entry_date, 0 as rnk, 'invoice'::text as entry_type,
           d.document_number as reference,
           coalesce(d.total, (d.snapshot->>'total')::numeric, 0) as amt
      from issued_documents d
      join sales_orders so on so.id = d.sales_order_id
     where d.kind = 'invoice' and d.voided_at is null and so.customer_id = p_customer_id
    union all
    select d.issued_at::date, 1, 'credit_note', d.document_number,
           -coalesce(d.total, (d.snapshot->>'total')::numeric, 0)
      from issued_documents d
      join sales_orders so on so.id = d.sales_order_id
     where d.kind = 'credit_note' and d.voided_at is null and so.customer_id = p_customer_id
    union all
    select r.receipt_date, 2, 'receipt',
           coalesce(nullif(btrim(r.reference), ''), nullif(btrim(r.method), ''), 'Receipt'),
           -r.amount
      from customer_receipts r
     where r.customer_id = p_customer_id
    union all
    select p.paid_date, 3, 'payment', d.document_number, -p.amount
      from invoice_payments p
      join issued_documents d on d.id = p.issued_document_id
      join sales_orders so on so.id = d.sales_order_id
     where p.receipt_id is null and so.customer_id = p_customer_id
  ),
  opening as (
    select coalesce(sum(amt), 0) as bal from tx where entry_date < p_start
  ),
  period as (
    select entry_date, rnk, entry_type, reference, amt,
           (select bal from opening)
             + sum(amt) over (order by entry_date, rnk, reference
                              rows between unbounded preceding and current row) as balance
      from tx
     where entry_date between p_start and p_end
  )
  select entry_date, entry_type, reference, debit, credit, balance
  from (
    select p_start as entry_date, -1 as rnk, 'opening'::text as entry_type,
           null::text as reference, null::numeric as debit, null::numeric as credit,
           (select bal from opening) as balance
    union all
    select entry_date, rnk, entry_type, reference,
           case when amt > 0 then amt end,
           case when amt < 0 then -amt end,
           balance
      from period
  ) x
  order by entry_date, rnk, reference nulls first;
$$;
revoke execute on function customer_ledger(uuid, date, date) from public;
grant  execute on function customer_ledger(uuid, date, date) to authenticated;

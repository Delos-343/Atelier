-- 0042_procurement_exceptions.sql  (Match-exceptions worklist)
--
-- The billing exceptions the three-way match flags, as a worklist: the purchase orders
-- whose bill runs ahead of (over_billed) or short of (under_billed) the goods received,
-- the ones worth resolving before a payment goes out. A thin filter over
-- purchase_order_register — the match is computed in exactly one place, and this just
-- keeps the rows that need attention — so it can never disagree with the badge shown on
-- the procurement screen. 'matched' and 'unbilled' orders are not exceptions and are left
-- out; ordered by the size of the gap so the largest discrepancies surface first.

create or replace function purchase_order_exceptions(p_supplier_id uuid default null)
returns table(
  purchase_order_id uuid,
  code              text,
  supplier_id       uuid,
  supplier_name     text,
  ordered_value     numeric,
  received_value    numeric,
  billed_net        numeric,
  variance          numeric,
  match_status      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.purchase_order_id,
    r.code,
    r.supplier_id,
    r.supplier_name,
    r.ordered_value,
    r.received_value,
    r.billed_net,
    r.variance,
    r.match_status
  from purchase_order_register(null) r
  where r.match_status in ('over_billed', 'under_billed')
    and (p_supplier_id is null or r.supplier_id = p_supplier_id)
  order by abs(r.variance) desc, r.code;
$$;
revoke execute on function purchase_order_exceptions(uuid) from public;
grant  execute on function purchase_order_exceptions(uuid) to authenticated;

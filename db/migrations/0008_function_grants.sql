-- 0008_function_grants.sql
-- PostgreSQL grants function EXECUTE to PUBLIC by default, which would let the
-- anon role invoke privileged RPCs: the dashboard aggregate, the SECURITY DEFINER
-- stock mutators, genealogy traversal, and user administration. Revoke PUBLIC and
-- re-grant to authenticated only. public_metrics() is intentionally left
-- anon-callable — it powers the public dashboard and exposes only safe aggregates.

revoke execute on function dashboard_metrics() from public;
grant  execute on function dashboard_metrics() to authenticated;

revoke execute on function post_movement(uuid, movement_type, numeric, unit_code, text, uuid, uuid) from public;
grant  execute on function post_movement(uuid, movement_type, numeric, unit_code, text, uuid, uuid) to authenticated;

revoke execute on function complete_production_order(uuid, text, uuid) from public;
grant  execute on function complete_production_order(uuid, text, uuid) to authenticated;

revoke execute on function record_qc(uuid, qc_status, numeric, numeric, text, uuid) from public;
grant  execute on function record_qc(uuid, qc_status, numeric, numeric, text, uuid) to authenticated;

revoke execute on function trace_lot_ancestors(uuid) from public;
grant  execute on function trace_lot_ancestors(uuid) to authenticated;

revoke execute on function trace_lot_descendants(uuid) from public;
grant  execute on function trace_lot_descendants(uuid) to authenticated;

revoke execute on function admin_list_users() from public;
grant  execute on function admin_list_users() to authenticated;

revoke execute on function admin_set_user_role(uuid, app_role) from public;
grant  execute on function admin_set_user_role(uuid, app_role) to authenticated;

revoke execute on function admin_revoke_user(uuid) from public;
grant  execute on function admin_revoke_user(uuid) to authenticated;

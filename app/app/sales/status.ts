/** sales_order_status → badge class, shared by the sales list and detail screens. */
export const SALES_STATUS_CLASS: Record<string, string> = {
  draft: 'badge-mute',
  confirmed: 'badge-warn',
  partially_shipped: 'badge-warn',
  shipped: 'badge-ok',
  cancelled: 'badge-bad',
};

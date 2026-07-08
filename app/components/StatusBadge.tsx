import type { ReactNode } from 'react';

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'mute';

/**
 * One status → badge renderer shared by every list and detail screen. Pass the tone
 * map for the enum; values not in the map render as a plain badge. The label defaults
 * to the raw value (override with children) so callers stay a single self-contained tag.
 */
export function StatusBadge({
  value,
  tones,
  children,
}: {
  value: string;
  tones: Record<string, BadgeTone>;
  children?: ReactNode;
}) {
  const tone = tones[value];
  return <span className={tone ? `badge badge-${tone}` : 'badge'}>{children ?? value}</span>;
}

/** inventory_lots.status → tone */
export const LOT_STATUS_TONES: Record<string, BadgeTone> = {
  available: 'ok',
  quarantine: 'warn',
  expired: 'bad',
  rejected: 'bad',
  consumed: 'mute',
};

/** production_orders.status → tone */
export const PRODUCTION_STATUS_TONES: Record<string, BadgeTone> = {
  planned: 'mute',
  in_progress: 'warn',
  completed: 'ok',
  cancelled: 'bad',
};

/** sales_order_status → tone */
export const SALES_STATUS_TONES: Record<string, BadgeTone> = {
  draft: 'mute',
  confirmed: 'warn',
  partially_shipped: 'warn',
  shipped: 'ok',
  cancelled: 'bad',
};

/** raw_materials.halal_status → tone */
export const HALAL_STATUS_TONES: Record<string, BadgeTone> = {
  certified: 'ok',
  in_review: 'warn',
  not_certified: 'bad',
};

/** derived formula-version compliance verdict → tone */
export const COMPLIANCE_TONES: Record<string, BadgeTone> = {
  compliant: 'ok',
  'non-compliant': 'bad',
};

/** invoice_receivables().status → tone */
export const RECEIVABLE_STATUS_TONES: Record<string, BadgeTone> = {
  open: 'warn',
  partially_paid: 'warn',
  paid: 'ok',
  void: 'mute',
};

/** invoice_receivables().status → human label */
export const RECEIVABLE_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
};

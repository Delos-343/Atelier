import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { publicMetricsSchema } from './metrics-schemas';

/** Non-sensitive operational aggregates for the public dashboard. */
export interface PublicMetrics {
  lotsTotal: number;
  lotsAvailable: number;
  lotsQuarantine: number;
  productsTotal: number;
  materialsTotal: number;
  productionTotal: number;
  productionCompleted: number;
  qcPassRate: number | null; // 0..1, or null when no QC checks recorded
}

/**
 * Reads public metrics via the anon-safe `public_metrics()` RPC. Returns null when
 * Supabase isn't configured, is unreachable, or the payload fails validation — so
 * the page degrades to a friendly empty state instead of erroring or showing NaNs.
 */
export async function getPublicMetrics(): Promise<PublicMetrics | null> {
  const supabase = createClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('public_metrics');
    if (error || !data) return null;

    const parsed = publicMetricsSchema.safeParse(data);
    if (!parsed.success) {
      logger.error('public_metrics: unexpected payload shape', { issues: parsed.error.issues });
      return null;
    }

    const m = parsed.data;
    return {
      lotsTotal: m.lots_total,
      lotsAvailable: m.lots_available,
      lotsQuarantine: m.lots_quarantine,
      productsTotal: m.products_total,
      materialsTotal: m.materials_total,
      productionTotal: m.production_total,
      productionCompleted: m.production_completed,
      qcPassRate: m.qc_pass_rate,
    };
  } catch {
    return null;
  }
}

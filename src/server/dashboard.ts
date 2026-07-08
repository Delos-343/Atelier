import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { dashboardSchema } from './metrics-schemas';

export interface CategoryValue {
  category: string;
  value: number;
}

export interface DashboardMetrics {
  inventory: {
    valueRaw: number;
    valueFinished: number;
    valueTotal: number;
    lotsByStatus: Record<string, number>;
    valueByCategory: CategoryValue[];
  };
  production: {
    byStatus: Record<string, number>;
    total: number;
  };
  qc: {
    passed: number;
    failed: number;
    pending: number;
    passRate: number | null;
  };
}

/**
 * Reads aggregated dashboard metrics via the authed `dashboard_metrics()` RPC.
 * Returns null when Supabase isn't configured, unreachable, or the payload fails
 * validation — so the page shows a friendly empty state instead of erroring/NaNs.
 */
export async function getDashboardMetrics(): Promise<DashboardMetrics | null> {
  const supabase = createClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('dashboard_metrics');
    if (error || !data) return null;

    const parsed = dashboardSchema.safeParse(data);
    if (!parsed.success) {
      logger.error('dashboard_metrics: unexpected payload shape', { issues: parsed.error.issues });
      return null;
    }

    const d = parsed.data;
    return {
      inventory: {
        valueRaw: d.inventory.value_raw,
        valueFinished: d.inventory.value_finished,
        valueTotal: d.inventory.value_raw + d.inventory.value_finished,
        lotsByStatus: d.inventory.lots_by_status,
        valueByCategory: d.inventory.value_by_category,
      },
      production: {
        byStatus: d.production.by_status,
        total: d.production.total,
      },
      qc: {
        passed: d.qc.passed,
        failed: d.qc.failed,
        pending: d.qc.pending,
        passRate: d.qc.pass_rate,
      },
    };
  } catch {
    return null;
  }
}

import { z } from 'zod';

/**
 * Validation schemas for the JSON-returning metric RPCs (`public_metrics`,
 * `dashboard_metrics`). Both RPCs build their payload with `json_build_object`
 * over `count(*)` and `round(numeric, 4)`, so every value is a JSON number (or
 * null for the rates) — hence strict `z.number()`. Parsing rather than asserting
 * means a drifted RPC shape is caught and logged instead of silently yielding NaNs.
 *
 * Kept free of Next/server imports so they can be unit-tested in isolation.
 * Unknown keys are stripped (Zod default), so additive RPC changes stay compatible.
 */

export const publicMetricsSchema = z.object({
  lots_total: z.number(),
  lots_available: z.number(),
  lots_quarantine: z.number(),
  products_total: z.number(),
  materials_total: z.number(),
  production_total: z.number(),
  production_completed: z.number(),
  qc_pass_rate: z.number().nullable(), // null when no QC checks recorded
});

export const dashboardSchema = z.object({
  inventory: z.object({
    value_raw: z.number(),
    value_finished: z.number(),
    lots_by_status: z.record(z.number()),
    value_by_category: z.array(z.object({ category: z.string(), value: z.number() })),
  }),
  production: z.object({
    by_status: z.record(z.number()),
    total: z.number(),
  }),
  qc: z.object({
    passed: z.number(),
    failed: z.number(),
    pending: z.number(),
    pass_rate: z.number().nullable(),
  }),
});

import { z } from 'zod';
import { unitEnum } from './formula';

export const createProductionOrderSchema = z.object({
  code: z.string().min(1),
  productId: z.string().uuid(),
  formulaVersionId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  plannedQuantity: z.number().positive(),
  unit: unitEnum,
});
export type CreateProductionOrderDTO = z.infer<typeof createProductionOrderSchema>;

export const recordQcSchema = z.object({
  lotId: z.string().uuid(),
  status: z.enum(['passed', 'failed']),
  specificGravity: z.number().positive().optional(),
  alcoholPct: z.number().min(0).max(100).optional(),
  notes: z.string().max(2000).optional(),
});
export type RecordQcDTO = z.infer<typeof recordQcSchema>;

export const previewProductionOrderSchema = z.object({
  formulaVersionId: z.string().uuid(),
  plannedQuantity: z.number().positive(),
  unit: unitEnum,
});
export type PreviewProductionOrderDTO = z.infer<typeof previewProductionOrderSchema>;

import { z } from 'zod';

export const unitEnum = z.enum(['kg', 'g', 'mg', 'l', 'ml']);

export const formulaComponentSchema = z.object({
  rawMaterialId: z.string().uuid(),
  quantity: z.number().positive(),
  unit: unitEnum,
  densityGPerMl: z.number().positive().optional(),
});

export const formulaSchema = z.object({
  basis: z.enum(['percent', 'mass']),
  components: z.array(formulaComponentSchema).min(1, 'formula needs at least one component'),
});

export type FormulaDTO = z.infer<typeof formulaSchema>;

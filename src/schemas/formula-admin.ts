import { z } from 'zod';

export const unitEnum = z.enum(['kg', 'g', 'mg', 'l', 'ml']);
export const basisEnum = z.enum(['percent', 'mass']);

export const formulaCreateSchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(64),
  name: z.string().trim().min(1, 'Name is required').max(200),
  product_id: z.string().uuid('Pick a product'),
});
export const formulaUpdateSchema = formulaCreateSchema.partial();

export const versionCreateSchema = z.object({
  formula_id: z.string().uuid(),
  basis: basisEnum,
  clone_from_version_id: z.string().uuid().nullish(),
});

export const componentInputSchema = z.object({
  raw_material_id: z.string().uuid('Pick a material'),
  quantity: z.coerce.number().positive('Quantity must be > 0'),
  unit: unitEnum,
  sequence: z.coerce.number().int().nonnegative().default(0),
});

export const versionSaveSchema = z.object({
  components: z.array(componentInputSchema),
  lock: z.boolean().optional().default(false),
});

export type FormulaCreateDTO = z.infer<typeof formulaCreateSchema>;
export type ComponentInput = z.infer<typeof componentInputSchema>;

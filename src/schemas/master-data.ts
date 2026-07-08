import { z } from 'zod';

export const unitEnum = z.enum(['kg', 'g', 'mg', 'l', 'ml']);
export const materialCategoryEnum = z.enum([
  'aroma_chemical',
  'essential_oil',
  'fixative',
  'solvent',
  'water',
  'packaging',
]);

const sku = z.string().trim().min(1, 'SKU is required').max(64);
const name = z.string().trim().min(1, 'Name is required').max(200);
const code = z.string().trim().min(1, 'Code is required').max(64);

// A form number input yields '' when empty; treat that as "omitted".
const optionalNumber = z
  .preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number())
  .optional();

// ---- raw_materials ----
export const materialCreateSchema = z.object({
  sku,
  name,
  category: materialCategoryEnum,
  base_unit: unitEnum,
  density_g_per_ml: optionalNumber.pipe(z.number().positive().optional()),
  standard_cost: optionalNumber.pipe(z.number().nonnegative().optional()),
  is_flammable: z.coerce.boolean().optional(),
});
export const materialUpdateSchema = materialCreateSchema.partial();

// ---- products ----
export const productCreateSchema = z.object({
  sku,
  name,
  base_unit: unitEnum,
});
export const productUpdateSchema = productCreateSchema.partial();

// ---- warehouses ----
export const warehouseCreateSchema = z.object({
  code,
  name,
});
export const warehouseUpdateSchema = warehouseCreateSchema.partial();

export type MaterialCreateDTO = z.infer<typeof materialCreateSchema>;
export type ProductCreateDTO = z.infer<typeof productCreateSchema>;
export type WarehouseCreateDTO = z.infer<typeof warehouseCreateSchema>;

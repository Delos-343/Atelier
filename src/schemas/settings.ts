import { z } from 'zod';

/**
 * Plant-wide standard cost rates. overheadRate is a fraction of prime cost
 * (material + labor) — e.g. 0.15 means 15%. The admin UI presents it as a percent
 * and converts; the API and DB stay in fractions. Bounds keep values inside the
 * numeric(6,4) overhead column and a sane labor range.
 */
export const costingSettingsSchema = z.object({
  laborRatePerHour: z.coerce
    .number({ invalid_type_error: 'Labor rate must be a number' })
    .min(0, 'Labor rate must be 0 or more')
    .max(9_999_999, 'Labor rate is too large'),
  overheadRate: z.coerce
    .number({ invalid_type_error: 'Overhead rate must be a number' })
    .min(0, 'Overhead rate must be 0 or more')
    .max(99, 'Overhead rate is too large'),
});
export type CostingSettingsDTO = z.infer<typeof costingSettingsSchema>;

/** The house VAT/PPN rate, as a percentage (0–100). Bounds match the numeric(5,2) column. */
export const taxSettingsSchema = z.object({
  ppnRate: z.coerce
    .number({ invalid_type_error: 'PPN rate must be a number' })
    .min(0, 'PPN rate must be 0 or more')
    .max(100, 'PPN rate cannot exceed 100%'),
});
export type TaxSettingsDTO = z.infer<typeof taxSettingsSchema>;

/**
 * A per-product override. Each rate is optional: null (or an empty field) means
 * "inherit the plant-wide standard". Empty string / undefined are normalised to null
 * BEFORE coercion, otherwise `z.coerce.number()` would turn them into 0 and silently
 * override with a real zero. At least one rate must be set — clearing both is a
 * removal, done via DELETE rather than an all-null row.
 */
const optionalRate = (max: number, label: string) =>
  z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? null : v),
    z.coerce
      .number({ invalid_type_error: `${label} must be a number` })
      .min(0, `${label} must be 0 or more`)
      .max(max, `${label} is too large`)
      .nullable(),
  );

export const productCostingRateSchema = z
  .object({
    productId: z.string().uuid('Select a product'),
    laborRatePerHour: optionalRate(9_999_999, 'Labor rate'),
    overheadRate: optionalRate(99, 'Overhead rate'),
  })
  .refine((v) => v.laborRatePerHour !== null || v.overheadRate !== null, {
    message: 'Set at least one rate, or remove the override.',
  });
export type ProductCostingRateDTO = z.infer<typeof productCostingRateSchema>;

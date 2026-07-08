import { z } from 'zod';
import { unitEnum } from './master-data';

const code = z.string().trim().min(1, 'Code is required').max(64);
const name = z.string().trim().min(1, 'Name is required').max(200);

// A form text input yields '' when empty; treat that as omitted (-> NULL).
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().max(max).optional(),
  );

// ---- customers ----
export const customerCreateSchema = z.object({
  code,
  name,
  email: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().email('Invalid email').max(200).optional(),
  ),
  phone: optionalText(64),
  address: optionalText(500),
  // The customer's NPWP (Indonesian tax ID); carried onto the Faktur Pajak export.
  tax_id: optionalText(50),
  // Net days the customer has to pay; drives each invoice's due date at issuance.
  payment_terms_days: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.coerce.number().int('Whole days only').min(0, 'Terms must be 0 or more days').max(3650, 'That is over ten years'),
    )
    .default(30),
  // Zero-rated for PPN (e.g. export); otherwise the house rate applies.
  tax_exempt: z.coerce.boolean().optional().default(false),
  // Standing discount applied to the invoice subtotal before tax.
  discount_pct: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.coerce.number().min(0, 'Discount must be 0 or more').max(100, 'Discount cannot exceed 100%'),
    )
    .default(0),
});
export const customerUpdateSchema = customerCreateSchema.partial();

// ---- sales orders ----
const lineSchema = z.object({
  productId: z.string().uuid('Invalid product'),
  quantity: z.coerce.number().positive('Quantity must be positive'),
  unit: unitEnum,
  unitPrice: z.coerce.number().nonnegative('Price must be ≥ 0').default(0),
});

export const createSalesOrderSchema = z.object({
  code,
  customerId: z.string().uuid('Select a customer'),
  warehouseId: z.string().uuid('Select a warehouse'),
  orderDate: z.string().trim().optional(), // ISO yyyy-mm-dd; defaults to today
  lines: z.array(lineSchema).min(1, 'Add at least one line'),
});
export type CreateSalesOrderInput = z.infer<typeof createSalesOrderSchema>;

export const setSalesOrderStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled']),
});

export const shipLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        quantity: z.number().nonnegative(),
      }),
    )
    .min(1, 'Specify at least one line'),
});
export type ShipLinesInput = z.infer<typeof shipLinesSchema>;

export const createReturnSchema = z.object({
  code: z.string().trim().min(1, 'Credit note code is required'),
  lines: z
    .array(
      z.object({
        lineId: z.string().uuid(),
        quantity: z.number().nonnegative(),
      }),
    )
    .min(1, 'Specify at least one line'),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

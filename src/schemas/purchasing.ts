import { z } from 'zod';

const code = z.string().trim().min(1, 'Code is required').max(64);
const name = z.string().trim().min(1, 'Name is required').max(200);

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().max(max).optional(),
  );

// ---- suppliers (mirror of customers) ----
export const supplierCreateSchema = z.object({
  code,
  name,
  email: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().email('Invalid email').max(200).optional(),
  ),
  phone: optionalText(64),
  address: optionalText(500),
  // The supplier's NPWP (Indonesian tax ID); carried onto the Faktur Pajak export.
  tax_id: optionalText(50),
  payment_terms_days: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.coerce.number().int('Whole days only').min(0, 'Terms must be 0 or more days').max(3650, 'That is over ten years'),
    )
    .default(30),
});
export const supplierUpdateSchema = supplierCreateSchema.partial();

// ---- bills ----
export const billCreateSchema = z.object({
  supplierId: z.string().uuid('Select a supplier'),
  billNumber: z.string().trim().min(1, 'A bill number is required').max(120),
  billDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the bill date as YYYY-MM-DD'),
  amount: z
    .number({ invalid_type_error: 'Enter the bill amount' })
    .finite()
    .positive('The amount must be greater than zero')
    .max(999_999_999_999.99, 'Amount is too large')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'The amount can have at most 2 decimal places',
    }),
  // Optional — the DB derives it from the supplier's terms when omitted.
  dueDate: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the due date as YYYY-MM-DD')
      .optional(),
  ),
  description: optionalText(500),
  // Optional input PPN inside the amount; defaults to zero.
  taxAmount: z
    .number()
    .finite()
    .min(0, 'Tax cannot be negative')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'The tax can have at most 2 decimal places',
    })
    .optional(),
});
export type BillCreateDTO = z.infer<typeof billCreateSchema>;

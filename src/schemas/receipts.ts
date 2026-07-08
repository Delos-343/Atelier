import { z } from 'zod';

const money2dp = z
  .number({ invalid_type_error: 'Enter an amount' })
  .finite()
  .positive('The amount must be greater than zero')
  .max(999_999_999_999.99, 'Amount is too large')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'The amount can have at most 2 decimal places',
  });

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/** One line of a receipt: apply this much to that invoice. */
export const allocationSchema = z.object({
  invoiceId: z.string().uuid('Select an invoice'),
  amount: money2dp,
});

/** Bank a receipt and (optionally) apply it across invoices in one go. */
export const receiptCreateSchema = z.object({
  customerId: z.string().uuid('Select a customer'),
  receiptDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the receipt date as YYYY-MM-DD'),
  amount: money2dp,
  method: optionalText(60),
  reference: optionalText(120),
  // May be empty (bank purely on account) or total less than the amount (leaves a remainder).
  allocations: z.array(allocationSchema).max(500, 'Too many allocations'),
});

/** Apply an existing receipt's remaining balance across invoices. */
export const applyReceiptSchema = z.object({
  allocations: z.array(allocationSchema).min(1, 'Add at least one allocation').max(500, 'Too many allocations'),
});

export type ReceiptCreateDTO = z.infer<typeof receiptCreateSchema>;
export type ApplyReceiptDTO = z.infer<typeof applyReceiptSchema>;

import { z } from 'zod';

/**
 * Record-a-payment request. The amount is money at currency precision: positive,
 * finite, at most 2 decimal places (the DB enforces the same rule exactly; this is
 * the friendly boundary). Method is free text — bank transfer, QRIS, cash, a
 * virtual-account rail — because payment rails vary by market and a closed enum
 * would just funnel everything into "other".
 */
export const recordPaymentSchema = z.object({
  amount: z
    .number({ invalid_type_error: 'Enter a payment amount' })
    .finite()
    .positive('The amount must be greater than zero')
    .max(999_999_999_999.99, 'Amount is too large')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'The amount can have at most 2 decimal places',
    }),
  paidDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the payment date as YYYY-MM-DD'),
  method: z.string().trim().max(60, 'Method is too long (60 characters max)').optional().default(''),
  reference: z.string().trim().max(120, 'Reference is too long (120 characters max)').optional().default(''),
});
export type RecordPaymentDTO = z.infer<typeof recordPaymentSchema>;

/** Void-a-document request: the reason goes on the permanent record. */
export const voidDocumentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required to void a document')
    .max(500, 'Reason is too long (500 characters max)'),
});
export type VoidDocumentDTO = z.infer<typeof voidDocumentSchema>;

/**
 * Apply-a-credit-note request. The amount follows the same money rule as a payment
 * (positive, finite, ≤ 2 dp — the DB enforces it exactly); the credit note to draw
 * on is chosen by id, and the date defaults to today when omitted.
 */
export const allocateCreditSchema = z.object({
  creditNoteId: z.string().uuid('Choose a credit note to apply'),
  amount: z
    .number({ invalid_type_error: 'Enter an amount to apply' })
    .finite()
    .positive('The amount must be greater than zero')
    .max(999_999_999_999.99, 'Amount is too large')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'The amount can have at most 2 decimal places',
    }),
  allocatedDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD')
    .optional()
    .default(() => new Date().toISOString().slice(0, 10)),
});
export type AllocateCreditDTO = z.infer<typeof allocateCreditSchema>;

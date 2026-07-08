import { z } from 'zod';

const unit = z.enum(['kg', 'g', 'mg', 'l', 'ml'], { errorMap: () => ({ message: 'Pick a unit' }) });
const ymd = (label: string) =>
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, `Enter ${label} as YYYY-MM-DD`);
const qty = z.number({ invalid_type_error: 'Enter a quantity' }).finite().positive('Must be greater than zero');

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const money2dp = z
  .number({ invalid_type_error: 'Enter an amount' })
  .finite()
  .positive('The amount must be greater than zero')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'The amount can have at most 2 decimal places',
  });

export const poLineSchema = z.object({
  rawMaterialId: z.string().uuid('Pick a material'),
  quantity: qty,
  unit,
  unitCost: z.number({ invalid_type_error: 'Enter a unit cost' }).finite().min(0, 'Cannot be negative'),
});

export const purchaseOrderCreateSchema = z.object({
  code: z.string().trim().min(1, 'A code is required').max(64),
  supplierId: z.string().uuid('Select a supplier'),
  warehouseId: z.string().uuid('Select a warehouse'),
  orderDate: ymd('the order date'),
  lines: z.array(poLineSchema).min(1, 'Add at least one line').max(200, 'Too many lines'),
});

export const receiptLineSchema = z.object({
  lineId: z.string().uuid(),
  quantity: qty,
  lotCode: z.string().trim().min(1, 'A lot code is required').max(64),
  expiryDate: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    ymd('the expiry date').optional(),
  ),
});

export const receivePurchaseOrderSchema = z.object({
  receipts: z.array(receiptLineSchema).min(1, 'Add at least one receipt line').max(200),
});

export const billPurchaseOrderSchema = z.object({
  billNumber: z.string().trim().min(1, 'A bill number is required').max(120),
  billDate: ymd('the bill date'),
  amount: money2dp.optional(),
  taxAmount: z
    .number()
    .finite()
    .min(0, 'Tax cannot be negative')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'The tax can have at most 2 decimal places',
    })
    .optional(),
  dueDate: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    ymd('the due date').optional(),
  ),
  description: optionalText(200),
});

export type PurchaseOrderCreateDTO = z.infer<typeof purchaseOrderCreateSchema>;
export type ReceivePurchaseOrderDTO = z.infer<typeof receivePurchaseOrderSchema>;
export type BillPurchaseOrderDTO = z.infer<typeof billPurchaseOrderSchema>;

import { z } from 'zod';

/**
 * Issue-document request. An invoice or packing slip is issued against an order; a credit
 * note against a credit note. The refinement enforces the right id for the chosen kind.
 */
export const issueDocumentSchema = z
  .object({
    kind: z.enum(['invoice', 'packing_slip', 'credit_note']),
    orderId: z.string().uuid().optional(),
    creditNoteId: z.string().uuid().optional(),
  })
  .refine((v) => (v.kind === 'credit_note' ? !!v.creditNoteId : !!v.orderId), {
    message: 'invoice and packing_slip require orderId; credit_note requires creditNoteId',
  });

export type IssueDocumentDTO = z.infer<typeof issueDocumentSchema>;

/**
 * Email-an-issued-document request. `to` is a single recipient address (RFC 5321
 * caps an address at 320 octets); subject and message are what the admin approved
 * in the form, bounded to keep the audit rows sane. All three are trimmed — a
 * subject of only whitespace is no subject.
 */
export const emailDocumentSchema = z.object({
  to: z
    .string()
    .trim()
    .min(1, 'A recipient email address is required')
    .max(320, 'Recipient address is too long')
    .email('Enter a valid recipient email address'),
  subject: z
    .string()
    .trim()
    .min(1, 'A subject is required')
    .max(200, 'Subject is too long (200 characters max)'),
  message: z
    .string()
    .trim()
    .min(1, 'A message is required')
    .max(4000, 'Message is too long (4,000 characters max)'),
});
export type EmailDocumentDTO = z.infer<typeof emailDocumentSchema>;

/** Emailing a statement of account: the same message fields, plus the period it covers. */
export const emailStatementSchema = emailDocumentSchema.extend({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Provide a start date as YYYY-MM-DD'),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Provide an end date as YYYY-MM-DD'),
});
export type EmailStatementDTO = z.infer<typeof emailStatementSchema>;

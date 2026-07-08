import { describe, it, expect } from 'vitest';
import { emailDocumentSchema, emailStatementSchema, issueDocumentSchema } from '../documents';

const OID = '00000000-0000-0000-0000-000000000001';
const CNID = '00000000-0000-0000-0000-000000000002';

describe('issueDocumentSchema', () => {
  it('requires an orderId for order-level kinds and a creditNoteId for credit notes', () => {
    expect(issueDocumentSchema.safeParse({ kind: 'invoice', orderId: OID }).success).toBe(true);
    expect(issueDocumentSchema.safeParse({ kind: 'packing_slip', orderId: OID }).success).toBe(true);
    expect(issueDocumentSchema.safeParse({ kind: 'credit_note', creditNoteId: CNID }).success).toBe(true);

    expect(issueDocumentSchema.safeParse({ kind: 'invoice' }).success).toBe(false);
    expect(issueDocumentSchema.safeParse({ kind: 'credit_note', orderId: OID }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(issueDocumentSchema.safeParse({ kind: 'receipt', orderId: OID }).success).toBe(false);
  });
});

describe('emailDocumentSchema', () => {
  const valid = {
    to: 'buyer@example.com',
    subject: 'Invoice SO-1 — TechnicoFlor',
    message: 'Please find attached.',
  };

  it('accepts a well-formed request and trims every field', () => {
    const r = emailDocumentSchema.safeParse({
      to: '  buyer@example.com  ',
      subject: '  Invoice SO-1  ',
      message: '  Body.  ',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.to).toBe('buyer@example.com');
      expect(r.data.subject).toBe('Invoice SO-1');
      expect(r.data.message).toBe('Body.');
    }
  });

  it('rejects a malformed or missing recipient address', () => {
    expect(emailDocumentSchema.safeParse({ ...valid, to: 'not-an-email' }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ ...valid, to: '' }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ subject: 'S', message: 'M' }).success).toBe(false);
  });

  it('rejects a whitespace-only subject or message (trim runs first)', () => {
    expect(emailDocumentSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ ...valid, message: '\n\n' }).success).toBe(false);
  });

  it('bounds the field lengths (320 / 200 / 4000)', () => {
    const longLocal = `${'a'.repeat(320)}@example.com`;
    expect(emailDocumentSchema.safeParse({ ...valid, to: longLocal }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ ...valid, subject: 'x'.repeat(201) }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ ...valid, subject: 'x'.repeat(200) }).success).toBe(true);
    expect(emailDocumentSchema.safeParse({ ...valid, message: 'x'.repeat(4001) }).success).toBe(false);
    expect(emailDocumentSchema.safeParse({ ...valid, message: 'x'.repeat(4000) }).success).toBe(true);
  });
});

describe('emailStatementSchema', () => {
  const valid = {
    to: 'buyer@example.com',
    subject: 'Statement of Account — TechnicoFlor',
    message: 'Please find attached.',
    start: '2026-07-01',
    end: '2026-07-31',
  };

  it('accepts a well-formed request with a period', () => {
    expect(emailStatementSchema.safeParse(valid).success).toBe(true);
  });

  it('inherits the email-field validation', () => {
    expect(emailStatementSchema.safeParse({ ...valid, to: 'not-an-email' }).success).toBe(false);
    expect(emailStatementSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
  });

  it('requires both dates in YYYY-MM-DD form', () => {
    expect(emailStatementSchema.safeParse({ ...valid, start: '2026/07/01' }).success).toBe(false);
    expect(emailStatementSchema.safeParse({ ...valid, end: 'July' }).success).toBe(false);
    const noStart = { to: valid.to, subject: valid.subject, message: valid.message, end: valid.end };
    expect(emailStatementSchema.safeParse(noStart).success).toBe(false);
  });
});

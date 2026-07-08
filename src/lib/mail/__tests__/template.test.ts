import { describe, it, expect } from 'vitest';
import { defaultDocumentEmail, defaultStatementEmail, DOCUMENT_KIND_LABEL } from '../template';

describe('defaultDocumentEmail', () => {
  it('builds the subject and body from the kind label and document number', () => {
    const d = defaultDocumentEmail('invoice', 'SO-2026-001', 'PT Wangi Nusantara');
    expect(d.subject).toBe('Invoice SO-2026-001 — TechnicoFlor');
    expect(d.message).toContain('Dear PT Wangi Nusantara,');
    expect(d.message).toContain('invoice SO-2026-001');
    expect(d.message).toContain('TechnicoFlor');
  });

  it('greets neutrally when the customer name is missing or blank', () => {
    expect(defaultDocumentEmail('packing_slip', 'SO-1').message).toMatch(/^Hello,/);
    expect(defaultDocumentEmail('packing_slip', 'SO-1', '   ').message).toMatch(/^Hello,/);
    expect(defaultDocumentEmail('packing_slip', 'SO-1', null).message).toMatch(/^Hello,/);
  });

  it('labels every issued-document kind and degrades an unknown kind to "Document"', () => {
    expect(defaultDocumentEmail('credit_note', 'CN-7').subject).toBe('Credit note CN-7 — TechnicoFlor');
    expect(defaultDocumentEmail('mystery', 'X-1').subject).toBe('Document X-1 — TechnicoFlor');
    expect(Object.keys(DOCUMENT_KIND_LABEL).sort()).toEqual(['credit_note', 'invoice', 'packing_slip']);
  });
});

describe('defaultStatementEmail', () => {
  it('names the period in the body and uses a fixed subject', () => {
    const d = defaultStatementEmail('PT Wangi Nusantara', '2026-07-01', '2026-07-31');
    expect(d.subject).toBe('Statement of Account — TechnicoFlor');
    expect(d.message).toMatch(/^Dear PT Wangi Nusantara,/);
    expect(d.message).toContain('2026-07-01 to 2026-07-31');
  });

  it('greets neutrally when the customer name is missing or blank', () => {
    expect(defaultStatementEmail(null, '2026-07-01', '2026-07-31').message).toMatch(/^Hello,/);
    expect(defaultStatementEmail('   ', '2026-07-01', '2026-07-31').message).toMatch(/^Hello,/);
  });
});

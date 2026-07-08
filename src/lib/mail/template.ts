/**
 * Default subject/body for emailing an issued document — a PURE module (no
 * transport, no server-only imports) so the client form can prefill from it and a
 * unit test can pin it. The admin sees and may edit both before anything is sent;
 * these are conveniences, not policy.
 */

/** Human label per issued-document kind, shared by the email template and the UI. */
export const DOCUMENT_KIND_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  packing_slip: 'Packing slip',
  credit_note: 'Credit note',
};

export interface DocumentEmailDraft {
  subject: string;
  message: string;
}

/**
 * Build the default draft for a document email. `customerName` personalises the
 * salutation when known; a missing name degrades to a neutral greeting rather
 * than an awkward blank.
 */
export function defaultDocumentEmail(
  kind: string,
  documentNumber: string,
  customerName?: string | null,
): DocumentEmailDraft {
  const label = DOCUMENT_KIND_LABEL[kind] ?? 'Document';
  const greeting = customerName?.trim() ? `Dear ${customerName.trim()},` : 'Hello,';
  return {
    subject: `${label} ${documentNumber} — TechnicoFlor`,
    message: [
      greeting,
      '',
      `Please find attached ${label.toLowerCase()} ${documentNumber} for your records.`,
      '',
      'Kind regards,',
      'TechnicoFlor',
    ].join('\n'),
  };
}

/**
 * Build the default draft for a statement-of-account email. Names the period so the
 * customer knows which statement they're receiving; a missing name degrades to a
 * neutral greeting.
 */
export function defaultStatementEmail(
  customerName: string | null | undefined,
  start: string,
  end: string,
): DocumentEmailDraft {
  const greeting = customerName?.trim() ? `Dear ${customerName.trim()},` : 'Hello,';
  return {
    subject: 'Statement of Account — TechnicoFlor',
    message: [
      greeting,
      '',
      `Please find attached your statement of account for the period ${start} to ${end}.`,
      '',
      'Kind regards,',
      'TechnicoFlor',
    ].join('\n'),
  };
}

import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

/** One recorded send — an issued document emailed to a customer, or a statement of account. */
export interface EmailHistoryEntry {
  sentAt: string;
  kind: 'document' | 'statement';
  docKind: string | null; // invoice / packing_slip / credit_note for documents; null for statements
  reference: string | null; // the document number, or the statement's period
  partyName: string | null;
  recipient: string;
  subject: string;
}

/**
 * The two email trails — document_emails and statement_emails — as one chronological log,
 * most recent first. Read straight from email_history(), which unions them, so the register
 * can't drift from what the DEFINER send-recorders actually wrote.
 */
export async function getEmailHistory(supabase: DbClient): Promise<ServerResult<EmailHistoryEntry[]>> {
  try {
    const { data, error } = await supabase.rpc('email_history');
    if (error) return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load the email history.' }) };
    const rows: EmailHistoryEntry[] = (data ?? []).map((r) => ({
      sentAt: r.sent_at,
      kind: r.kind as 'document' | 'statement',
      docKind: r.doc_kind,
      reference: r.reference,
      partyName: r.party_name,
      recipient: r.recipient,
      subject: r.subject,
    }));
    return { ok: true, data: rows };
  } catch (e) {
    logger.error('emailHistory.getEmailHistory threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load the email history.', status: 500 };
  }
}

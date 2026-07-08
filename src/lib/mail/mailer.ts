import nodemailer from 'nodemailer';
import { logger } from '@/lib/logger';

/**
 * Outbound email over SMTP — SERVER ONLY (nodemailer opens sockets; it must never
 * reach a client bundle, and the window guard below hard-fails if it somehow does).
 *
 * SMTP was chosen over a provider SDK deliberately: every serious mail provider
 * (Resend, SES, Mailgun, Postmark, a corporate relay) exposes an SMTP endpoint, so
 * one configuration story covers them all — and it is the same kind of credential
 * the Supabase project already needs for auth invitations (v0.13), not a second
 * vendor account. nodemailer is pure JS with zero dependencies.
 *
 * Configuration (see .env.example) mirrors the service-role key's graceful
 * degradation: with SMTP_HOST / MAIL_FROM unset, `isMailConfigured()` is false, the
 * UI disables the send action and says why, and the API answers 503 — nothing throws.
 */

export interface MailEnv {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * Read and validate the SMTP environment. Returns null unless the two
 * load-bearing values — the relay host and the From address — are present.
 * Port defaults to 587 (STARTTLS submission); SMTP_SECURE=true forces implicit
 * TLS and otherwise it is inferred from port 465. Credentials are optional as a
 * pair (IP-authorised relays need none); a half-set pair is treated as unset.
 */
export function mailEnv(env: Record<string, string | undefined> = process.env): MailEnv | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host || !from) return null;

  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const secure = env.SMTP_SECURE != null ? env.SMTP_SECURE === 'true' : port === 465;
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS || undefined; // passwords may legitimately begin/end with spaces
  return { host, port, secure, user: user && pass ? user : undefined, pass: user && pass ? pass : undefined, from };
}

/** Whether document emailing is available (SMTP host + From address configured). */
export const isMailConfigured = (): boolean => mailEnv() !== null;

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

export type MailResult = { ok: true } | { ok: false; error: string };

/**
 * Send one message through the configured relay. The transport is constructed per
 * send (like the service-role client: per request, no module-level state); at this
 * feature's volume — an admin emailing a document — pooling would buy nothing.
 * Failures are logged with detail server-side and returned as a generic message,
 * so relay hostnames and SMTP error internals never reach the client.
 */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
  if (typeof window !== 'undefined') {
    throw new Error('sendMail must never be called in the browser.');
  }
  const env = mailEnv();
  if (!env) return { ok: false, error: 'Email is not configured on the server.' };

  try {
    const transporter = nodemailer.createTransport({
      host: env.host,
      port: env.port,
      secure: env.secure,
      auth: env.user && env.pass ? { user: env.user, pass: env.pass } : undefined,
    });
    await transporter.sendMail({
      from: env.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return { ok: true };
  } catch (e) {
    logger.error('mail.send failed', {
      message: e instanceof Error ? e.message : String(e),
      host: env.host,
      port: env.port,
    });
    return { ok: false, error: 'The mail server refused the message or could not be reached.' };
  }
}

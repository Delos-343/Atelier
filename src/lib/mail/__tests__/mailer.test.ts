import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { mailEnv, sendMail } from '../mailer';
import { renderIssuedPdf } from '@/server/pdf/documentPdf';
import type { InvoiceDocument } from '@/server/documents';

// ── mailEnv: reading and validating the SMTP configuration ──────────────────

describe('mailEnv', () => {
  const base = { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'TF <docs@tf.example>' };

  it('is null unless both the host and the From address are present', () => {
    expect(mailEnv({})).toBeNull();
    expect(mailEnv({ SMTP_HOST: 'smtp.example.com' })).toBeNull();
    expect(mailEnv({ MAIL_FROM: 'docs@tf.example' })).toBeNull();
    expect(mailEnv({ SMTP_HOST: '  ', MAIL_FROM: 'docs@tf.example' })).toBeNull();
    expect(mailEnv(base)).not.toBeNull();
  });

  it('defaults to port 587 with STARTTLS (secure=false)', () => {
    const env = mailEnv(base);
    expect(env?.port).toBe(587);
    expect(env?.secure).toBe(false);
  });

  it('infers implicit TLS on port 465 and honours an explicit SMTP_SECURE', () => {
    expect(mailEnv({ ...base, SMTP_PORT: '465' })?.secure).toBe(true);
    expect(mailEnv({ ...base, SMTP_PORT: '465', SMTP_SECURE: 'false' })?.secure).toBe(false);
    expect(mailEnv({ ...base, SMTP_PORT: '587', SMTP_SECURE: 'true' })?.secure).toBe(true);
  });

  it('rejects an unusable port outright', () => {
    expect(mailEnv({ ...base, SMTP_PORT: 'abc' })).toBeNull();
    expect(mailEnv({ ...base, SMTP_PORT: '0' })).toBeNull();
    expect(mailEnv({ ...base, SMTP_PORT: '70000' })).toBeNull();
  });

  it('treats credentials as a pair — a half-set pair is unset', () => {
    const both = mailEnv({ ...base, SMTP_USER: 'u', SMTP_PASS: 'p' });
    expect(both?.user).toBe('u');
    expect(both?.pass).toBe('p');
    const userOnly = mailEnv({ ...base, SMTP_USER: 'u' });
    expect(userOnly?.user).toBeUndefined();
    expect(userOnly?.pass).toBeUndefined();
  });
});

// ── sendMail: a real SMTP round-trip against a loopback server ───────────────
// The one part of this feature a sandbox usually can't verify — the SMTP
// conversation and the attachment encoding — is exercised here against a real
// (local) SMTP server, in the same spirit as the DB suites running against live
// PostgreSQL. Only a production relay (DNS, TLS, provider auth) needs your env.

const MAIL_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'] as const;

describe('sendMail (loopback SMTP)', () => {
  const saved: Record<string, string | undefined> = {};
  const received: string[] = [];
  let server: SMTPServer;

  beforeAll(async () => {
    for (const k of MAIL_KEYS) saved[k] = process.env[k];

    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, done) {
        let buf = '';
        stream.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
        });
        stream.on('end', () => {
          received.push(buf);
          done();
        });
      },
    });
    const port = await new Promise<number>((resolve) => {
      const s = server.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
    });

    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.SMTP_SECURE = 'false';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    process.env.MAIL_FROM = 'TechnicoFlor <docs@technicoflor.test>';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const k of MAIL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports not-configured cleanly when the SMTP env is absent', async () => {
    const host = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    const res = await sendMail({ to: 'a@b.test', subject: 'S', text: 'T' });
    process.env.SMTP_HOST = host;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not configured/i);
  });

  it('delivers the message with the issued PDF attached, intact', async () => {
    const snapshot: InvoiceDocument = {
      kind: 'invoice',
      number: 'SO-9',
      date: '2026-07-03',
      status: 'shipped',
      customer: { code: 'C9', name: 'PT Wangi', email: 'customer@example.test', phone: null, address: null },
      warehouse: { code: 'WH1', name: 'Main' },
      lines: [{ sku: 'EDP-50', name: 'Eau de Parfum 50ml', quantity: 2, unit: 'ml', unitPrice: 50, lineTotal: 100 }],
      total: 100,
    };
    const pdf = await renderIssuedPdf('invoice', snapshot);

    const res = await sendMail({
      to: 'customer@example.test',
      subject: 'Invoice SO-9 from TechnicoFlor',
      text: 'Please find attached invoice SO-9 for your records.',
      attachments: [{ filename: 'Invoice-SO-9.pdf', content: Buffer.from(pdf), contentType: 'application/pdf' }],
    });
    expect(res).toEqual({ ok: true });
    expect(received).toHaveLength(1);

    const raw = received[0];
    expect(raw).toMatch(/^To: customer@example\.test$/m);
    expect(raw).toMatch(/^From: TechnicoFlor <docs@technicoflor\.test>$/m);
    expect(raw).toMatch(/^Subject: Invoice SO-9 from TechnicoFlor$/m);
    expect(raw).toContain('Please find attached invoice SO-9');
    expect(raw).toMatch(/Content-Type: application\/pdf/);
    expect(raw).toMatch(/filename="?Invoice-SO-9\.pdf"?/);
    // base64 of "%PDF-" — the attachment really is the rendered PDF
    expect(raw).toContain('JVBERi0');
  });

  it('returns a clean failure when the relay is unreachable (no throw)', async () => {
    const port = process.env.SMTP_PORT;
    process.env.SMTP_PORT = '1'; // nothing listens here — immediate ECONNREFUSED
    const res = await sendMail({ to: 'a@b.test', subject: 'S', text: 'T' });
    process.env.SMTP_PORT = port;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/mail server/i);
  });
});

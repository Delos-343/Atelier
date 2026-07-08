'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { Stat } from '../../../components/Stat';
import { useApiData } from '../../../components/offline/useApiData';
import { api, errMsg } from '@/lib/api-client';
import { money } from '@/lib/format';
import { defaultStatementEmail } from '@/lib/mail/template';
import type { CustomerLedger } from '@/server/receivables';

type LedgerData = CustomerLedger & { emailEnabled: boolean };

interface Customer {
  id: string;
  code: string;
  name: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthBounds(year: number, month: number) {
  return { start: iso(new Date(year, month, 1)), end: iso(new Date(year, month + 1, 0)) };
}

const LABEL: Record<string, string> = {
  opening: 'Balance brought forward',
  invoice: 'Invoice',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  payment: 'Payment',
};

export default function CustomerLedgerPage() {
  const now = new Date();
  const thisMonth = monthBounds(now.getFullYear(), now.getMonth());
  const customers = useApiData<Customer[]>('/api/admin/customers');

  const [customerId, setCustomerId] = useState('');
  const [start, setStart] = useState(thisMonth.start);
  const [end, setEnd] = useState(thisMonth.end);

  const [data, setData] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [showEmail, setShowEmail] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!customerId) {
      setData(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const d = await api<LedgerData>(`/api/receivables/ledger/${customerId}?start=${start}&end=${end}`);
      setData(d);
    } catch (e) {
      setErr(errMsg(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [customerId, start, end]);

  useEffect(() => {
    void load();
  }, [load]);

  function setMonth(offset: number) {
    const b = monthBounds(now.getFullYear(), now.getMonth() + offset);
    setStart(b.start);
    setEnd(b.end);
  }
  function setQuarter() {
    const qtr = Math.floor(now.getMonth() / 3);
    setStart(iso(new Date(now.getFullYear(), qtr * 3, 1)));
    setEnd(iso(new Date(now.getFullYear(), qtr * 3 + 3, 0)));
  }
  function setYear() {
    setStart(`${now.getFullYear()}-01-01`);
    setEnd(`${now.getFullYear()}-12-31`);
  }

  const pdfHref = customerId
    ? `/api/receivables/ledger/${customerId}?start=${start}&end=${end}&format=pdf`
    : '#';

  function openEmail() {
    if (!data?.customer) return;
    const draft = defaultStatementEmail(data.customer.name, start, end);
    setEmailTo(data.customer.email ?? '');
    setEmailSubject(draft.subject);
    setEmailMessage(draft.message);
    setEmailErr(null);
    setEmailNote(null);
    setShowEmail(true);
  }

  async function sendEmail() {
    setEmailSending(true);
    setEmailErr(null);
    try {
      const res = await api<{ recipient: string }>(`/api/receivables/ledger/${customerId}/send`, {
        method: 'POST',
        body: JSON.stringify({ to: emailTo, subject: emailSubject, message: emailMessage, start, end }),
      });
      setEmailNote(`Statement emailed to ${res.recipient}.`);
      setShowEmail(false);
      void load(); // refresh the "last emailed" line
    } catch (e) {
      setEmailErr(errMsg(e));
    } finally {
      setEmailSending(false);
    }
  }

  return (
    <Page>
      <PageHeader title="Customer statement">
        <Link href="/app/receivables" className="text-accent hover:underline">
          ← Receivables
        </Link>
      </PageHeader>

      <div className="card">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">Customer</span>
            <select className="input w-64" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Select a customer…</option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">From</span>
            <input className="input w-40" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input className="input w-40" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(0)}>
              This month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMonth(-1)}>
              Last month
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setQuarter}>
              This quarter
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={setYear}>
              This year
            </button>
          </div>
        </div>
        {err && <p className="mt-2 text-[0.85rem] text-bad">{err}</p>}
        {!customerId && <p className="mt-2 text-muted text-[0.9rem]">Pick a customer to see their account.</p>}
      </div>

      {customerId && loading && !data && <p className="mt-4 text-muted text-[0.9rem]">Loading…</p>}

      {data && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="grid grid-cols-2 gap-3 sm:w-96">
              <Stat label="Opening balance" value={money(data.openingBalance)} />
              <Stat label="Balance due" value={money(data.closingBalance)} />
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <a className="btn btn-sm btn-ghost" href={pdfHref} target="_blank" rel="noopener noreferrer">
                  Download PDF
                </a>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={openEmail}
                  disabled={!data.emailEnabled}
                  title={data.emailEnabled ? undefined : 'SMTP is not configured on the server'}
                >
                  Email statement
                </button>
              </div>
              {data.lastEmail && (
                <p className="text-[0.78rem] text-muted">
                  Last emailed {data.lastEmail.sentAt.slice(0, 10)} to{' '}
                  <span className="mono">{data.lastEmail.recipient}</span>
                </p>
              )}
              {emailNote && <p className="text-[0.78rem] text-accent">{emailNote}</p>}
            </div>
          </div>

          {!data.emailEnabled && (
            <p className="mt-2 text-[0.8rem] text-muted">
              Emailing is disabled — set SMTP_HOST and MAIL_FROM on the server (see .env.example) to send statements.
            </p>
          )}

          {showEmail && (
            <div className="card mt-4">
              <h2 className="section-label">Email statement</h2>
              <div className="mt-2 grid gap-3">
                <label className="flex flex-col gap-1">
                  <span className="label">To</span>
                  <input
                    className="input"
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    disabled={emailSending}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Subject</span>
                  <input
                    className="input"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    disabled={emailSending}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label">Message</span>
                  <textarea
                    className="input"
                    rows={6}
                    value={emailMessage}
                    onChange={(e) => setEmailMessage(e.target.value)}
                    disabled={emailSending}
                  />
                </label>
                <p className="text-[0.8rem] text-muted">
                  The statement PDF for {start} to {end} is attached automatically.
                </p>
                {emailErr && <p className="text-[0.85rem] text-bad">{emailErr}</p>}
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm" onClick={sendEmail} disabled={emailSending}>
                    {emailSending ? 'Sending…' : 'Send'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setShowEmail(false)}
                    disabled={emailSending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          <section className="card mt-4 overflow-x-auto">
            <table className="w-full text-[0.9rem]">
              <thead>
                <tr className="text-muted text-[0.78rem] uppercase tracking-[0.06em]">
                  <th className="py-1 text-left font-medium">Date</th>
                  <th className="py-1 text-left font-medium">Detail</th>
                  <th className="py-1 text-right font-medium">Charges</th>
                  <th className="py-1 text-right font-medium">Payments</th>
                  <th className="py-1 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e, i) => {
                  const label = LABEL[e.type] ?? e.type;
                  const detail = e.type === 'opening' ? label : e.reference ? `${label} ${e.reference}` : label;
                  return (
                    <tr key={i} className={`border-t border-[var(--border)] ${e.type === 'opening' ? 'text-muted' : ''}`}>
                      <td className="py-1.5">{e.type === 'opening' ? '' : e.date.slice(0, 10)}</td>
                      <td className="py-1.5">{detail}</td>
                      <td className="py-1.5 text-right mono">{e.debit != null ? money(e.debit) : ''}</td>
                      <td className="py-1.5 text-right mono">{e.credit != null ? money(e.credit) : ''}</td>
                      <td className="py-1.5 text-right mono">{money(e.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <p className="mt-3 text-[0.82rem] text-muted">
            A running account: charges raise the balance, credit notes and payments reduce it, and the balance is
            carried down each line. Cash receipts are shown in full, so any amount received on account nets against
            what's owed — this can make the balance due lower than the sum of open invoices in the aged report.
          </p>
        </>
      )}
    </Page>
  );
}

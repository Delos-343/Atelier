'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Page, PageHeader } from '../../../components/Page';
import { useApiData } from '../../../components/offline/useApiData';
import { DataTable, type Column } from '../../../components/DataTable';
import { useRole } from '../../../components/auth/SessionProvider';
import { api, errMsg } from '@/lib/api-client';
import type { SalesOrderDetail, CostedLine, CreditNoteSummary } from '@/server/sales';
import type { IssuedDocumentSummary } from '@/server/issuedDocuments';
import type { AvailableCredit } from '@/server/receivables';
import { defaultDocumentEmail, DOCUMENT_KIND_LABEL } from '@/lib/mail/template';
import { money, moneyOrDash } from '@/lib/format';
import {
  StatusBadge,
  SALES_STATUS_TONES,
  RECEIVABLE_STATUS_TONES,
  RECEIVABLE_STATUS_LABEL,
} from '../../../components/StatusBadge';
import { Stat } from '../../../components/Stat';

const buildLineColumns = (realized: boolean, hasReturns: boolean): Column<CostedLine>[] => {
  const product: Column<CostedLine> = {
    key: 'product',
    header: 'Product',
    render: (l) => (
      <span>
        <span className="mono">{l.sku}</span> <span className="text-soft">{l.name}</span>
      </span>
    ),
  };
  const price: Column<CostedLine> = {
    key: 'price',
    header: 'Unit price',
    align: 'right',
    render: (l) => <span className="mono">{money(l.unitPrice)}</span>,
  };
  if (realized) {
    return [
      product,
      { key: 'ordered', header: 'Ordered', align: 'right', render: (l) => <span className="mono">{l.quantity} {l.unit}</span> },
      { key: 'shipped', header: 'Shipped', align: 'right', render: (l) => <span className="mono">{l.shippedQuantity} {l.unit}</span> },
      ...(hasReturns
        ? [
            {
              key: 'returned',
              header: 'Returned',
              align: 'right' as const,
              render: (l: CostedLine) => <span className="mono">{l.returnedQuantity} {l.unit}</span>,
            },
          ]
        : []),
      price,
      { key: 'cogs', header: 'COGS', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.cogs)}</span> },
      { key: 'rmargin', header: 'Realized margin', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.realizedMargin)}</span> },
    ];
  }
  return [
    product,
    { key: 'qty', header: 'Qty', align: 'right', render: (l) => <span className="mono">{l.quantity} {l.unit}</span> },
    price,
    { key: 'cost', header: 'Est. unit cost', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.estUnitCost)}</span> },
    { key: 'rev', header: 'Revenue', align: 'right', render: (l) => <span className="mono">{money(l.lineRevenue)}</span> },
    { key: 'emargin', header: 'Exp. margin', align: 'right', render: (l) => <span className="mono">{moneyOrDash(l.expectedMargin)}</span> },
  ];
};

const issuedColumns = (handlers: {
  onEmail: (d: IssuedDocumentSummary) => void;
  onPay: (d: IssuedDocumentSummary) => void;
  onApplyCredit: (d: IssuedDocumentSummary) => void;
  onVoid: (d: IssuedDocumentSummary) => void;
  emailEnabled: boolean;
}): Column<IssuedDocumentSummary>[] => [
  { key: 'kind', header: 'Document', render: (d) => <span>{DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}</span> },
  {
    key: 'number',
    header: 'Number',
    render: (d) => (
      <span className="flex items-center gap-2">
        <span
          className={`mono ${d.voided ? 'text-muted line-through' : ''}`}
          title={d.voided ? d.voidReason ?? undefined : undefined}
        >
          {d.documentNumber}
        </span>
        {d.voided && <span className="badge badge-mute">void</span>}
      </span>
    ),
  },
  { key: 'issued', header: 'Issued', render: (d) => <span className="mono">{d.issuedAt.slice(0, 10)}</span> },
  {
    key: 'payment',
    header: 'Payment',
    render: (d) => {
      // Credit notes show how much credit is still available to apply.
      if (d.kind === 'credit_note' && !d.voided && d.creditRemaining != null) {
        return d.creditRemaining > 0 ? (
          <span className="mono text-[0.8rem] text-muted">{money(d.creditRemaining)} credit left</span>
        ) : (
          <span className="text-[0.8rem] text-muted">fully applied</span>
        );
      }
      // Receivable state is derived (invoice_receivables) and applies to live
      // invoices only — a voided invoice reads from its struck number, and packing
      // slips carry no balance. `open` now nets both payments and applied credit.
      if (d.kind !== 'invoice' || d.voided || !d.paymentStatus) return <span className="text-muted">—</span>;
      return (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge value={d.paymentStatus} tones={RECEIVABLE_STATUS_TONES}>
            {RECEIVABLE_STATUS_LABEL[d.paymentStatus] ?? d.paymentStatus}
          </StatusBadge>
          {d.open != null && d.open > 0 && (
            <span className="mono text-[0.8rem] text-muted">{money(d.open)} open</span>
          )}
          {d.allocated != null && d.allocated > 0 && (
            <span className="mono text-[0.8rem] text-muted">· {money(d.allocated)} credit</span>
          )}
        </span>
      );
    },
  },
  {
    key: 'emailed',
    header: 'Emailed',
    render: (d) =>
      d.emails.length === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <span className="text-[0.82rem]">
          <span className="mono">{d.emails[0].recipient}</span>
          <span className="text-muted">
            {' '}
            · {d.emails[0].sentAt.slice(0, 10)}
            {d.emails.length > 1 ? ` · ×${d.emails.length}` : ''}
          </span>
        </span>
      ),
  },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: (d) => (
      <span className="flex items-center justify-end gap-3">
        <a
          href={`/api/issued-documents/${d.id}?format=pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline"
        >
          PDF
        </a>
        {!d.voided && (
          <button
            type="button"
            className="text-accent underline disabled:opacity-50"
            onClick={() => handlers.onEmail(d)}
            disabled={!handlers.emailEnabled}
            title={handlers.emailEnabled ? undefined : 'SMTP is not configured on the server'}
          >
            Email…
          </button>
        )}
        {d.kind === 'invoice' && !d.voided && (d.open ?? 0) > 0 && (
          <button type="button" className="text-accent underline" onClick={() => handlers.onPay(d)}>
            Pay…
          </button>
        )}
        {d.kind === 'invoice' && !d.voided && ((d.open ?? 0) > 0 || d.allocations.length > 0) && (
          <button type="button" className="text-accent underline" onClick={() => handlers.onApplyCredit(d)}>
            {(d.open ?? 0) > 0 ? 'Apply credit…' : 'Credit…'}
          </button>
        )}
        {!d.voided && (
          <button type="button" className="text-bad underline" onClick={() => handlers.onVoid(d)}>
            Void…
          </button>
        )}
      </span>
    ),
  },
];

const creditNoteColumns = (
  onIssue: (creditNoteId: string) => void,
  issuingId: string | null,
): Column<CreditNoteSummary>[] => [
  { key: 'code', header: 'Code', render: (c) => <span className="mono">{c.code}</span> },
  { key: 'date', header: 'Date', render: (c) => <span className="mono">{c.creditDate}</span> },
  { key: 'total', header: 'Credited', align: 'right', render: (c) => <span className="mono">{money(c.total)}</span> },
  { key: 'cogs', header: 'COGS reversed', align: 'right', render: (c) => <span className="mono">{money(c.cogsReversed)}</span> },
  {
    key: 'actions',
    header: '',
    align: 'right',
    render: (c) => (
      <span className="flex items-center justify-end gap-3">
        <Link href={`/print/credit-note/${c.id}`} target="_blank" className="text-accent underline">
          Print
        </Link>
        <button
          type="button"
          className="text-accent underline disabled:opacity-50"
          onClick={() => onIssue(c.id)}
          disabled={issuingId === c.id}
        >
          {issuingId === c.id ? 'Issuing…' : 'Issue'}
        </button>
      </span>
    ),
  },
];


export default function SalesOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const role = useRole();
  const { data: o, error, loading, reload } = useApiData<SalesOrderDetail>(`/api/sales/${params.id}`);
  const issued = useApiData<{ documents: IssuedDocumentSummary[]; emailEnabled: boolean }>(
    `/api/issued-documents?orderId=${params.id}`,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [issuing, setIssuing] = useState<string | null>(null);
  const [emailDoc, setEmailDoc] = useState<IssuedDocumentSummary | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  // Pay / Void cards are keyed by document id (not a captured object) so the open
  // card always reflects freshly reloaded payment state after a record or delete.
  const [payDocId, setPayDocId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [payReference, setPayReference] = useState('');
  const [paySaving, setPaySaving] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  const [voidDocId, setVoidDocId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidSaving, setVoidSaving] = useState(false);
  const [voidErr, setVoidErr] = useState<string | null>(null);
  // Apply-credit card, keyed by the invoice id (mirrors the pay card).
  const [creditInvId, setCreditInvId] = useState<string | null>(null);
  const [availCredits, setAvailCredits] = useState<AvailableCredit[]>([]);
  const [creditChoice, setCreditChoice] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditDate, setCreditDate] = useState('');
  const [creditLoading, setCreditLoading] = useState(false);
  const [creditSaving, setCreditSaving] = useState(false);
  const [creditErr, setCreditErr] = useState<string | null>(null);
  const [docNote, setDocNote] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [returnCode, setReturnCode] = useState('');

  const stateBox = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

  async function issueDoc(kind: 'invoice' | 'packing_slip' | 'credit_note', creditNoteId?: string) {
    setIssuing(kind === 'credit_note' ? creditNoteId ?? 'credit_note' : kind);
    setMsg(null);
    try {
      await api('/api/issued-documents', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          orderId: kind === 'credit_note' ? undefined : params.id,
          creditNoteId,
        }),
      });
      issued.reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setIssuing(null);
    }
  }

  function openEmail(d: IssuedDocumentSummary) {
    const draft = defaultDocumentEmail(d.kind, d.documentNumber, o?.customer?.name);
    setPayDocId(null);
    setVoidDocId(null);
    setEmailDoc(d);
    setEmailTo(o?.customer?.email ?? '');
    setEmailSubject(draft.subject);
    setEmailMessage(draft.message);
    setEmailErr(null);
    setEmailNote(null);
    setDocNote(null);
  }

  async function sendEmail() {
    if (!emailDoc) return;
    setEmailSending(true);
    setEmailErr(null);
    try {
      const res = await api<{ recipient: string }>(`/api/issued-documents/${emailDoc.id}/email`, {
        method: 'POST',
        body: JSON.stringify({ to: emailTo, subject: emailSubject, message: emailMessage }),
      });
      setEmailNote(
        `${DOCUMENT_KIND_LABEL[emailDoc.kind] ?? 'Document'} ${emailDoc.documentNumber} sent to ${res.recipient}.`,
      );
      setEmailDoc(null);
      issued.reload();
    } catch (e) {
      setEmailErr(errMsg(e));
    } finally {
      setEmailSending(false);
    }
  }

  function openPay(d: IssuedDocumentSummary) {
    setEmailDoc(null);
    setVoidDocId(null);
    setPayDocId(d.id);
    setPayAmount(d.open != null && d.open > 0 ? String(d.open) : '');
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMethod('');
    setPayReference('');
    setPayErr(null);
    setDocNote(null);
  }

  async function savePayment() {
    if (!payDoc) return;
    setPaySaving(true);
    setPayErr(null);
    try {
      await api(`/api/issued-documents/${payDoc.id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(payAmount),
          paidDate: payDate,
          method: payMethod,
          reference: payReference,
        }),
      });
      setDocNote(`Payment recorded against ${payDoc.documentNumber}.`);
      setPayAmount('');
      setPayMethod('');
      setPayReference('');
      issued.reload();
    } catch (e) {
      setPayErr(errMsg(e));
    } finally {
      setPaySaving(false);
    }
  }

  async function deletePayment(paymentId: string) {
    if (!window.confirm('Delete this payment? The invoice balance will reopen by that amount.')) return;
    setPaySaving(true);
    setPayErr(null);
    try {
      await api(`/api/payments/${paymentId}`, { method: 'DELETE' });
      setDocNote('Payment deleted; the balance has reopened.');
      issued.reload();
    } catch (e) {
      setPayErr(errMsg(e));
    } finally {
      setPaySaving(false);
    }
  }

  async function openCredit(d: IssuedDocumentSummary) {
    setEmailDoc(null);
    setPayDocId(null);
    setVoidDocId(null);
    setDocNote(null);
    setCreditInvId(d.id);
    setCreditErr(null);
    setCreditChoice('');
    setCreditAmount('');
    setCreditDate(new Date().toISOString().slice(0, 10));
    setAvailCredits([]);
    const cust = o?.customer?.id;
    if (!cust) return;
    setCreditLoading(true);
    try {
      const credits = await api<AvailableCredit[]>(`/api/receivables/credits?customerId=${cust}`);
      setAvailCredits(credits);
      if (credits.length > 0) {
        const first = credits[0];
        setCreditChoice(first.id);
        const cap = Math.min(d.open ?? 0, first.remaining);
        setCreditAmount(cap > 0 ? String(cap) : '');
      }
    } catch (e) {
      setCreditErr(errMsg(e));
    } finally {
      setCreditLoading(false);
    }
  }

  function chooseCredit(creditId: string) {
    setCreditChoice(creditId);
    const c = availCredits.find((x) => x.id === creditId);
    if (c && creditDoc) {
      const cap = Math.min(creditDoc.open ?? 0, c.remaining);
      setCreditAmount(cap > 0 ? String(cap) : '');
    }
  }

  async function applyCredit() {
    if (!creditDoc) return;
    setCreditSaving(true);
    setCreditErr(null);
    try {
      await api(`/api/issued-documents/${creditDoc.id}/allocations`, {
        method: 'POST',
        body: JSON.stringify({
          creditNoteId: creditChoice,
          amount: Number(creditAmount),
          allocatedDate: creditDate,
        }),
      });
      setDocNote(`Credit applied to ${creditDoc.documentNumber}.`);
      setCreditInvId(null);
      issued.reload();
    } catch (e) {
      setCreditErr(errMsg(e));
    } finally {
      setCreditSaving(false);
    }
  }

  async function removeAllocation(allocationId: string) {
    if (!window.confirm('Remove this credit? The invoice balance and the credit note both reopen by that amount.'))
      return;
    setCreditSaving(true);
    setCreditErr(null);
    try {
      await api(`/api/allocations/${allocationId}`, { method: 'DELETE' });
      setDocNote('Credit removed; the balance has reopened.');
      issued.reload();
    } catch (e) {
      setCreditErr(errMsg(e));
    } finally {
      setCreditSaving(false);
    }
  }

  function openVoid(d: IssuedDocumentSummary) {
    setEmailDoc(null);
    setPayDocId(null);
    setVoidDocId(d.id);
    setVoidReason('');
    setVoidErr(null);
    setDocNote(null);
  }

  async function saveVoid() {
    if (!voidDoc) return;
    setVoidSaving(true);
    setVoidErr(null);
    try {
      await api(`/api/issued-documents/${voidDoc.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setDocNote(`${DOCUMENT_KIND_LABEL[voidDoc.kind] ?? 'Document'} ${voidDoc.documentNumber} voided.`);
      setVoidDocId(null);
      issued.reload();
    } catch (e) {
      setVoidErr(errMsg(e));
    } finally {
      setVoidSaving(false);
    }
  }

  async function setStatus(status: 'confirmed' | 'cancelled') {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function ship() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/ship`, { method: 'POST' });
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const lineCap = (l: CostedLine): number =>
    Math.min(l.quantity - l.shippedQuantity, l.availableQuantity);

  function openSplit() {
    if (!o) return;
    const init: Record<string, string> = {};
    for (const l of o.lines) {
      const cap = lineCap(l);
      if (cap > 0) init[l.lineId] = String(cap);
    }
    setQtys(init);
    setMsg(null);
    setSplitOpen(true);
  }

  async function shipLines() {
    const lines = Object.entries(qtys)
      .map(([lineId, v]) => ({ lineId, quantity: Number(v) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (lines.length === 0) {
      setMsg('Enter a quantity for at least one line.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/ship-lines`, {
        method: 'POST',
        body: JSON.stringify({ lines }),
      });
      setSplitOpen(false);
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const netOut = (l: CostedLine): number => l.shippedQuantity - l.returnedQuantity;

  function openReturn() {
    if (!o) return;
    setReturnQtys({});
    setReturnCode(`CN-${o.code}`);
    setMsg(null);
    setReturnOpen(true);
  }

  async function createReturnReq() {
    if (!returnCode.trim()) {
      setMsg('Enter a credit note code.');
      return;
    }
    const lines = Object.entries(returnQtys)
      .map(([lineId, v]) => ({ lineId, quantity: Number(v) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (lines.length === 0) {
      setMsg('Enter a return quantity for at least one line.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/sales/${params.id}/return`, {
        method: 'POST',
        body: JSON.stringify({ code: returnCode.trim(), lines }),
      });
      setReturnOpen(false);
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  // Derived live from the reloaded list, so a card refreshes its own payment
  // history and open balance after every record / delete.
  const issuedDocs = issued.data?.documents ?? [];
  const payDoc = payDocId ? issuedDocs.find((d) => d.id === payDocId) ?? null : null;
  const voidDoc = voidDocId ? issuedDocs.find((d) => d.id === voidDocId) ?? null : null;
  const creditDoc = creditInvId ? issuedDocs.find((d) => d.id === creditInvId) ?? null : null;

  const realized = !!o && (o.status === 'shipped' || o.status === 'partially_shipped');
  const outstanding = o ? o.lines.reduce((s, l) => s + Math.max(0, l.quantity - l.shippedQuantity), 0) : 0;
  const hasNetOut = !!o && o.lines.some((l) => l.shippedQuantity - l.returnedQuantity > 0);
  const hasReturns = !!o && o.lines.some((l) => l.returnedQuantity > 0);

  return (
    <Page>
      <PageHeader title="Sales order">
        Expected-margin preview before shipment; realized COGS and margin from the issued lots as the
        order ships — in full or in part, with the remainder on backorder.
      </PageHeader>

      <Link href="/app/sales" className="text-[0.85rem] text-muted hover:text-text">
        ← All orders
      </Link>

      <div className="mt-4">
        {loading && !o ? (
          <p className={stateBox}>Loading…</p>
        ) : error && !o ? (
          <p className={stateBox}>Could not load — {error}</p>
        ) : !o ? (
          <p className={stateBox}>No order found.</p>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono text-[1.1rem]">{o.code}</span>
              <StatusBadge value={o.status} tones={SALES_STATUS_TONES} />
              <span className="text-[0.9rem] text-text-soft">
                {o.customer ? `${o.customer.code} · ${o.customer.name}` : '—'}
              </span>
              <span className="mono text-[0.85rem] text-muted">{o.orderDate}</span>
            </div>

            {role === 'admin' && (
              <div className="flex flex-wrap items-center gap-3 text-[0.85rem]">
                <span className="text-muted">Documents:</span>
                <Link href={`/print/invoice/${params.id}`} target="_blank" className="text-accent underline">
                  Invoice
                </Link>
                <Link
                  href={`/print/packing-slip/${params.id}`}
                  target="_blank"
                  className="text-accent underline"
                >
                  Packing slip
                </Link>
              </div>
            )}

            {role === 'admin' && o.status !== 'cancelled' && (
              <div className="flex flex-wrap gap-2.5">
                {o.status === 'draft' && (
                  <button className="btn btn-sm" onClick={() => setStatus('confirmed')} disabled={busy}>
                    {busy ? 'Working…' : 'Confirm order'}
                  </button>
                )}
                {(o.status === 'confirmed' || o.status === 'partially_shipped') && (
                  <>
                    <button className="btn btn-sm" onClick={ship} disabled={busy}>
                      {busy ? 'Shipping…' : 'Ship available'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={openSplit} disabled={busy}>
                      Ship specific…
                    </button>
                  </>
                )}
                {(o.status === 'shipped' || o.status === 'partially_shipped') && hasNetOut && (
                  <button className="btn btn-sm btn-ghost" onClick={openReturn} disabled={busy}>
                    Process return…
                  </button>
                )}
                {(o.status === 'draft' || o.status === 'confirmed') && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setStatus('cancelled')} disabled={busy}>
                    Cancel order
                  </button>
                )}
              </div>
            )}

            {splitOpen && (o.status === 'confirmed' || o.status === 'partially_shipped') && (
              <div className="card flex flex-col gap-3">
                <div className="section-label">Ship specific quantities</div>
                {o.lines.filter((l) => l.quantity - l.shippedQuantity > 0).length === 0 ? (
                  <p className="text-[0.85rem] text-muted">Every line is already fully shipped.</p>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
                      {o.lines
                        .filter((l) => l.quantity - l.shippedQuantity > 0)
                        .map((l) => {
                          const cap = lineCap(l);
                          return (
                            <div key={l.lineId} className="flex flex-wrap items-center gap-3">
                              <span className="min-w-[10rem] flex-1">
                                <span className="mono">{l.sku}</span>{' '}
                                <span className="text-soft">{l.name}</span>
                              </span>
                              <span className="text-[0.78rem] text-muted">
                                {l.quantity - l.shippedQuantity} outstanding · {l.availableQuantity} available
                              </span>
                              <input
                                type="number"
                                className="input w-24"
                                min={0}
                                max={cap}
                                step="any"
                                value={qtys[l.lineId] ?? ''}
                                disabled={cap <= 0 || busy}
                                onChange={(e) => setQtys((q) => ({ ...q, [l.lineId]: e.target.value }))}
                              />
                              <span className="text-[0.78rem] text-muted">{l.unit}</span>
                            </div>
                          );
                        })}
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      <button className="btn btn-sm" onClick={shipLines} disabled={busy}>
                        {busy ? 'Shipping…' : 'Ship these quantities'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setSplitOpen(false)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {returnOpen && (o.status === 'shipped' || o.status === 'partially_shipped') && (
              <div className="card flex flex-col gap-3">
                <div className="section-label">Process return</div>
                {o.lines.filter((l) => netOut(l) > 0).length === 0 ? (
                  <p className="text-[0.85rem] text-muted">Nothing is currently out with the customer.</p>
                ) : (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="label">Credit note code</span>
                      <input
                        className="input max-w-xs"
                        value={returnCode}
                        onChange={(e) => setReturnCode(e.target.value)}
                        placeholder="CN-2026-001"
                      />
                    </label>
                    <div className="flex flex-col gap-2">
                      {o.lines
                        .filter((l) => netOut(l) > 0)
                        .map((l) => (
                          <div key={l.lineId} className="flex flex-wrap items-center gap-3">
                            <span className="min-w-[10rem] flex-1">
                              <span className="mono">{l.sku}</span>{' '}
                              <span className="text-soft">{l.name}</span>
                            </span>
                            <span className="text-[0.78rem] text-muted">
                              {netOut(l)} out (of {l.shippedQuantity} shipped)
                            </span>
                            <input
                              type="number"
                              className="input w-24"
                              min={0}
                              max={netOut(l)}
                              step="any"
                              value={returnQtys[l.lineId] ?? ''}
                              disabled={busy}
                              onChange={(e) => setReturnQtys((q) => ({ ...q, [l.lineId]: e.target.value }))}
                            />
                            <span className="text-[0.78rem] text-muted">{l.unit}</span>
                          </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      <button className="btn btn-sm" onClick={createReturnReq} disabled={busy}>
                        {busy ? 'Processing…' : 'Process return'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setReturnOpen(false)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-[0.78rem] text-muted">
                      Returned goods re-enter stock as a new available lot at their blended cost; a
                      credit note records the refunded value.
                    </p>
                  </>
                )}
              </div>
            )}
            {msg && <p className="text-[0.85rem] text-bad">{msg}</p>}

            <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr))]">
              {realized ? (
                <>
                  <Stat label="Shipped revenue" value={moneyOrDash(o.realizedRevenue)} />
                  <Stat label="Realized COGS" value={moneyOrDash(o.realizedCogs)} />
                  <Stat label="Realized margin" value={moneyOrDash(o.realizedMargin)} />
                  {hasReturns && <Stat label="Returned (credited)" value={moneyOrDash(o.returnedValue)} />}
                </>
              ) : (
                <>
                  <Stat label="Revenue" value={money(o.totalRevenue)} />
                  <Stat label="Expected COGS" value={money(o.expectedCogs)} />
                  <Stat label="Expected margin" value={moneyOrDash(o.expectedMargin)} />
                </>
              )}
            </div>

            <div>
              <h2 className="section-label mb-[0.85rem]">Lines</h2>
              <DataTable columns={buildLineColumns(realized, hasReturns)} rows={o.lines} rowKey={(l) => l.lineId} />
              {!realized && o.expectedMargin == null && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  Expected margin is shown only where the product has costed finished stock on hand;
                  realized margin is recorded at shipment.
                </p>
              )}
              {o.status === 'partially_shipped' && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  Partially shipped — {outstanding} unit{outstanding === 1 ? '' : 's'} on backorder.
                  Shipped revenue, COGS, and margin cover only what has been dispatched; ship again once
                  stock is available.
                </p>
              )}
              {o.status === 'shipped' && (
                <p className="mt-2 text-[0.8rem] text-muted">
                  COGS and realized margin are frozen from the specific finished lots issued at shipment.
                </p>
              )}
            </div>

            {o.creditNotes.length > 0 && (
              <div>
                <h2 className="section-label mb-[0.85rem]">Credit notes</h2>
                <DataTable
                  columns={creditNoteColumns((cnId) => issueDoc('credit_note', cnId), issuing)}
                  rows={o.creditNotes}
                  rowKey={(c) => c.id}
                />
              </div>
            )}

            {role === 'admin' && (
              <div>
                <h2 className="section-label mb-[0.85rem]">Issued documents</h2>
                <p className="mb-3 text-[0.8rem] text-muted">
                  Filing a document freezes it as an immutable record — its figures won&apos;t change if
                  the order is edited later, and the PDF re-renders from that frozen snapshot.
                </p>
                <div className="mb-3 flex flex-wrap gap-2.5">
                  <button
                    className="btn btn-sm"
                    onClick={() => issueDoc('invoice')}
                    disabled={issuing === 'invoice'}
                  >
                    {issuing === 'invoice' ? 'Issuing…' : 'Issue invoice'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => issueDoc('packing_slip')}
                    disabled={issuing === 'packing_slip'}
                  >
                    {issuing === 'packing_slip' ? 'Issuing…' : 'Issue packing slip'}
                  </button>
                </div>
                {emailNote && <p className="mb-3 text-[0.85rem] text-ok">{emailNote}</p>}
                {docNote && <p className="mb-3 text-[0.85rem] text-ok">{docNote}</p>}
                {issued.loading && !issued.data ? (
                  <p className="text-[0.85rem] text-muted">Loading…</p>
                ) : issued.data && issued.data.documents.length > 0 ? (
                  <DataTable
                    columns={issuedColumns({
                      onEmail: openEmail,
                      onPay: openPay,
                      onApplyCredit: openCredit,
                      onVoid: openVoid,
                      emailEnabled: issued.data.emailEnabled,
                    })}
                    rows={issued.data.documents}
                    rowKey={(d) => d.id}
                  />
                ) : (
                  <p className="text-[0.85rem] text-muted">No documents issued yet.</p>
                )}
                {issued.data && !issued.data.emailEnabled && issued.data.documents.length > 0 && (
                  <p className="mt-2 text-[0.8rem] text-muted">
                    Emailing is disabled — set SMTP_HOST and MAIL_FROM on the server (see
                    .env.example) to send documents to customers.
                  </p>
                )}
                {emailDoc && (
                  <div className="card mt-3 flex flex-col gap-3">
                    <div className="section-label">
                      Email {(DOCUMENT_KIND_LABEL[emailDoc.kind] ?? 'document').toLowerCase()}{' '}
                      {emailDoc.documentNumber}
                    </div>
                    <label className="flex flex-col gap-1">
                      <span className="label">To</span>
                      <input
                        type="email"
                        className="input max-w-sm"
                        value={emailTo}
                        onChange={(e) => setEmailTo(e.target.value)}
                        placeholder="customer@example.com"
                        disabled={emailSending}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="label">Subject</span>
                      <input
                        className="input max-w-xl"
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        disabled={emailSending}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="label">Message</span>
                      <textarea
                        className="input max-w-xl"
                        rows={6}
                        value={emailMessage}
                        onChange={(e) => setEmailMessage(e.target.value)}
                        disabled={emailSending}
                      />
                    </label>
                    {emailErr && <p className="text-[0.85rem] text-bad">{emailErr}</p>}
                    <div className="flex flex-wrap gap-2.5">
                      <button className="btn btn-sm" onClick={sendEmail} disabled={emailSending}>
                        {emailSending ? 'Sending…' : 'Send email'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setEmailDoc(null)}
                        disabled={emailSending}
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-[0.78rem] text-muted">
                      The issued PDF is attached exactly as filed — its figures won&apos;t reflect any
                      later edits to the order — and the send is recorded against the document.
                    </p>
                  </div>
                )}
                {payDoc && (
                  <div className="card mt-3 flex flex-col gap-3">
                    <div className="section-label">Payments · invoice {payDoc.documentNumber}</div>
                    <p className="text-[0.82rem] text-muted">
                      Claim {money(payDoc.total ?? 0)} · paid {money(payDoc.paid ?? 0)} ·{' '}
                      <span className={(payDoc.open ?? 0) > 0 ? 'text-text' : 'text-ok'}>
                        {(payDoc.open ?? 0) > 0 ? `${money(payDoc.open ?? 0)} open` : 'fully paid'}
                      </span>
                    </p>
                    {payDoc.payments.length > 0 && (
                      <ul className="flex flex-col gap-1.5">
                        {payDoc.payments.map((p) => (
                          <li
                            key={p.id}
                            className="flex items-center justify-between gap-3 border-b border-border pb-1.5 text-[0.85rem] last:border-0 last:pb-0"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="mono">{p.paidDate}</span>
                              <span className="mono">{money(p.amount)}</span>
                              {p.method && <span className="text-muted">{p.method}</span>}
                              {p.reference && <span className="text-muted">· {p.reference}</span>}
                            </span>
                            <button
                              type="button"
                              className="text-bad underline disabled:opacity-50"
                              onClick={() => deletePayment(p.id)}
                              disabled={paySaving}
                              title="Delete this payment"
                            >
                              Delete
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {(payDoc.open ?? 0) > 0 ? (
                      <>
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="label">Amount</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              className="input w-36"
                              value={payAmount}
                              onChange={(e) => setPayAmount(e.target.value)}
                              disabled={paySaving}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="label">Date</span>
                            <input
                              type="date"
                              className="input w-44"
                              value={payDate}
                              onChange={(e) => setPayDate(e.target.value)}
                              disabled={paySaving}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="label">Method</span>
                            <input
                              className="input w-44"
                              list="pay-methods"
                              value={payMethod}
                              onChange={(e) => setPayMethod(e.target.value)}
                              placeholder="bank transfer"
                              disabled={paySaving}
                            />
                            <datalist id="pay-methods">
                              <option value="Bank transfer" />
                              <option value="QRIS" />
                              <option value="Cash" />
                              <option value="Cheque" />
                              <option value="Card" />
                            </datalist>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="label">Reference</span>
                            <input
                              className="input w-52"
                              value={payReference}
                              onChange={(e) => setPayReference(e.target.value)}
                              placeholder="optional"
                              disabled={paySaving}
                            />
                          </label>
                        </div>
                        {payErr && <p className="text-[0.85rem] text-bad">{payErr}</p>}
                        <div className="flex flex-wrap gap-2.5">
                          <button className="btn btn-sm" onClick={savePayment} disabled={paySaving}>
                            {paySaving ? 'Saving…' : 'Record payment'}
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setPayDocId(null)}
                            disabled={paySaving}
                          >
                            Close
                          </button>
                        </div>
                        <p className="text-[0.78rem] text-muted">
                          A payment can&apos;t exceed the open balance, and is recorded to 2 decimal
                          places. Correct a mistaken entry with Delete — the balance reopens.
                        </p>
                      </>
                    ) : (
                      <>
                        {payErr && <p className="text-[0.85rem] text-bad">{payErr}</p>}
                        <div className="flex flex-wrap gap-2.5">
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setPayDocId(null)}
                            disabled={paySaving}
                          >
                            Close
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {creditDoc && (
                  <div className="card mt-3 flex flex-col gap-3">
                    <div className="section-label">Apply credit · invoice {creditDoc.documentNumber}</div>
                    <p className="text-[0.82rem] text-muted">
                      Claim {money(creditDoc.total ?? 0)} · paid {money(creditDoc.paid ?? 0)} ·{' '}
                      {(creditDoc.allocated ?? 0) > 0 && <>credit {money(creditDoc.allocated ?? 0)} · </>}
                      <span className={(creditDoc.open ?? 0) > 0 ? 'text-text' : 'text-ok'}>
                        {(creditDoc.open ?? 0) > 0 ? `${money(creditDoc.open ?? 0)} open` : 'settled'}
                      </span>
                    </p>
                    {creditDoc.allocations.length > 0 && (
                      <ul className="flex flex-col gap-1.5">
                        {creditDoc.allocations.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between gap-3 border-b border-border pb-1.5 text-[0.85rem] last:border-0 last:pb-0"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="mono">{a.allocatedDate}</span>
                              <span className="mono">{money(a.amount)}</span>
                              <span className="text-muted">
                                from{' '}
                                <Link
                                  href={`/app/sales/${a.counterpartOrderId}`}
                                  className="mono text-accent underline"
                                >
                                  {a.counterpartNumber}
                                </Link>
                              </span>
                            </span>
                            <button
                              type="button"
                              className="text-bad underline disabled:opacity-50"
                              onClick={() => removeAllocation(a.id)}
                              disabled={creditSaving}
                              title="Remove this credit"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {(creditDoc.open ?? 0) > 0 ? (
                      creditLoading ? (
                        <p className="text-[0.85rem] text-muted">Loading available credit…</p>
                      ) : availCredits.length === 0 ? (
                        <>
                          <p className="text-[0.85rem] text-muted">
                            This customer has no credit notes with credit left to apply.
                          </p>
                          <div className="flex flex-wrap gap-2.5">
                            <button className="btn btn-sm btn-ghost" onClick={() => setCreditInvId(null)}>
                              Close
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-end gap-3">
                            <label className="flex flex-col gap-1">
                              <span className="label">Credit note</span>
                              <select
                                className="input w-72"
                                value={creditChoice}
                                onChange={(e) => chooseCredit(e.target.value)}
                                disabled={creditSaving}
                              >
                                {availCredits.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.documentNumber} — {money(c.remaining)} left
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="label">Amount</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                className="input w-36"
                                value={creditAmount}
                                onChange={(e) => setCreditAmount(e.target.value)}
                                disabled={creditSaving}
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="label">Date</span>
                              <input
                                type="date"
                                className="input w-44"
                                value={creditDate}
                                onChange={(e) => setCreditDate(e.target.value)}
                                disabled={creditSaving}
                              />
                            </label>
                          </div>
                          {creditErr && <p className="text-[0.85rem] text-bad">{creditErr}</p>}
                          <div className="flex flex-wrap gap-2.5">
                            <button className="btn btn-sm" onClick={applyCredit} disabled={creditSaving}>
                              {creditSaving ? 'Applying…' : 'Apply credit'}
                            </button>
                            <button
                              className="btn btn-sm btn-ghost"
                              onClick={() => setCreditInvId(null)}
                              disabled={creditSaving}
                            >
                              Close
                            </button>
                          </div>
                          <p className="text-[0.78rem] text-muted">
                            A credit can&apos;t exceed the invoice&apos;s open balance or the note&apos;s
                            remaining credit. Remove a mistaken entry — both balances reopen.
                          </p>
                        </>
                      )
                    ) : (
                      <>
                        {creditErr && <p className="text-[0.85rem] text-bad">{creditErr}</p>}
                        <div className="flex flex-wrap gap-2.5">
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setCreditInvId(null)}
                            disabled={creditSaving}
                          >
                            Close
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {voidDoc && (
                  <div className="card mt-3 flex flex-col gap-3">
                    <div className="section-label">
                      Void {(DOCUMENT_KIND_LABEL[voidDoc.kind] ?? 'document').toLowerCase()}{' '}
                      {voidDoc.documentNumber}
                    </div>
                    <label className="flex flex-col gap-1">
                      <span className="label">Reason</span>
                      <input
                        className="input max-w-xl"
                        value={voidReason}
                        onChange={(e) => setVoidReason(e.target.value)}
                        placeholder="e.g. issued against the wrong order"
                        disabled={voidSaving}
                      />
                    </label>
                    {voidErr && <p className="text-[0.85rem] text-bad">{voidErr}</p>}
                    <div className="flex flex-wrap gap-2.5">
                      <button className="btn btn-sm" onClick={saveVoid} disabled={voidSaving}>
                        {voidSaving ? 'Voiding…' : 'Void document'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setVoidDocId(null)}
                        disabled={voidSaving}
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-[0.78rem] text-muted">
                      Voiding keeps the document in the archive — stamped VOID on its PDF, with this reason
                      on the record — rather than deleting it. An invoice with recorded payments can&apos;t
                      be voided; remove its payments first.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

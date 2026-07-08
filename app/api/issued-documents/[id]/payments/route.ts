import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { recordInvoicePayment } from '@/server/issuedDocuments';
import { recordPaymentSchema } from '@/schemas/payments';

export const dynamic = 'force-dynamic';

/**
 * Record a payment against an issued invoice. Every business rule — invoice kind,
 * not voided, 2 dp, never past the open balance under the invoice's row lock —
 * lives in record_invoice_payment() and its raised messages pass through to the
 * caller; this route only authenticates, validates shape, and relays.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = recordPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const { amount, paidDate, method, reference } = parsed.data;
  const result = await recordInvoicePayment(auth.supabase, {
    issuedDocumentId: params.id,
    amount,
    paidDate,
    method: method || null,
    reference: reference || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

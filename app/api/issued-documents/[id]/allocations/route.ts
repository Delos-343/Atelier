import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { allocateCreditNote } from '@/server/issuedDocuments';
import { allocateCreditSchema } from '@/schemas/payments';

export const dynamic = 'force-dynamic';

/**
 * Apply a credit note to this invoice ([id]). Every business rule — both kinds, same
 * customer, neither voided, never past the credit's remaining or the invoice's open
 * balance under a row lock — lives in allocate_credit_note() and its messages pass
 * through; this route authenticates, validates shape, and relays.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = allocateCreditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' }, { status: 400 });
  }

  const { creditNoteId, amount, allocatedDate } = parsed.data;
  const result = await allocateCreditNote(auth.supabase, {
    invoiceId: params.id,
    creditNoteId,
    amount,
    allocatedDate,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

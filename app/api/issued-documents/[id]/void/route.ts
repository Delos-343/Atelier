import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { voidIssuedDocument } from '@/server/issuedDocuments';
import { voidDocumentSchema } from '@/schemas/payments';

export const dynamic = 'force-dynamic';

/**
 * Void a mis-issued document. The archive stays append-only — nothing is deleted;
 * the void itself goes on the record with a reason and the voiding admin's id.
 * void_issued_document() enforces the guards (admin, reason, not already void,
 * no recorded payments) and its messages pass through.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = voidDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const result = await voidIssuedDocument(auth.supabase, params.id, parsed.data.reason);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

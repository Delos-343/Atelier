import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listIssuedDocumentsRegister } from '@/server/issuedDocuments';

export const dynamic = 'force-dynamic';

/**
 * The documents register: every issued document across all orders, with its order,
 * send summary, and (for invoices) receivable state. Derived in one place by
 * issued_documents_register(); this route authenticates and relays. Admin-only.
 */
export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const result = await listIssuedDocumentsRegister(auth.supabase);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ data: result.data });
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { issueDocument, listIssuedDocuments } from '@/server/issuedDocuments';
import { issueDocumentSchema } from '@/schemas/documents';
import { isMailConfigured } from '@/lib/mail/mailer';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const orderId = new URL(request.url).searchParams.get('orderId');
  if (!orderId) return NextResponse.json({ error: 'orderId is required.' }, { status: 400 });
  const res = await listIssuedDocuments(auth.supabase, orderId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  // emailEnabled tells the UI whether SMTP is configured, so it can enable the
  // per-document send action or explain why it is off — the canManageAccounts pattern.
  return NextResponse.json({ data: { documents: res.data, emailEnabled: isMailConfigured() } });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = issueDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  const res = await issueDocument(auth.supabase, parsed.data);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

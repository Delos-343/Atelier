import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { saveVersion, deleteVersion } from '@/server/formulas';
import { versionSaveSchema } from '@/schemas/formula-admin';

export const dynamic = 'force-dynamic';

type Ctx = { params: { vid: string } };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function PUT(request: Request, { params }: Ctx) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = versionSaveSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
  const res = await saveVersion(auth.supabase, params.vid, parsed.data.components, parsed.data.lock);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await deleteVersion(auth.supabase, params.vid);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { createVersion } from '@/server/formulas';
import { versionCreateSchema } from '@/schemas/formula-admin';

export const dynamic = 'force-dynamic';

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = versionCreateSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
  const res = await createVersion(auth.supabase, {
    formulaId: parsed.data.formula_id,
    basis: parsed.data.basis,
    cloneFromVersionId: parsed.data.clone_from_version_id ?? null,
  });
  return res.ok
    ? NextResponse.json({ data: res.data }, { status: 201 })
    : fail(res.error, res.status);
}

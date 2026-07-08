import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { createRow } from '@/server/crud';
import { listFormulas } from '@/server/formulas';
import { formulaCreateSchema } from '@/schemas/formula-admin';

export const dynamic = 'force-dynamic';

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await listFormulas(auth.supabase);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = formulaCreateSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
  const res = await createRow(auth.supabase, 'formulas', parsed.data);
  return res.ok
    ? NextResponse.json({ data: res.data }, { status: 201 })
    : fail(res.error, res.status);
}

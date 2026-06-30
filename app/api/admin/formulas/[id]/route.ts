import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { updateRow, deleteRow } from '@/server/crud';
import { getFormulaDetail } from '@/server/formulas';
import { formulaUpdateSchema } from '@/schemas/formula-admin';

export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(_request: Request, { params }: Ctx) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await getFormulaDetail(auth.supabase, params.id);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  const parsed = formulaUpdateSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
  const res = await updateRow(auth.supabase, 'formulas', params.id, parsed.data);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await deleteRow(auth.supabase, 'formulas', params.id);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

import { NextResponse } from 'next/server';
import type { ZodTypeAny } from 'zod';
import { apiAuth } from '@/lib/auth/api-guard';
import { listRows, createRow, updateRow, deleteRow } from '@/server/crud';

type Ctx = { params: { id: string } };

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/** GET (list) + POST (create) handlers for a master-data collection, admin-gated. */
export function makeCollectionRoute(opts: {
  table: string;
  columns: string;
  createSchema: ZodTypeAny;
}) {
  async function GET() {
    const auth = await apiAuth('admin');
    if (!auth.ok) return auth.response;
    const res = await listRows(auth.supabase, opts.table, opts.columns);
    return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
  }

  async function POST(request: Request) {
    const auth = await apiAuth('admin');
    if (!auth.ok) return auth.response;
    const body = await request.json().catch(() => null);
    const parsed = opts.createSchema.safeParse(body);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
    const res = await createRow(auth.supabase, opts.table, parsed.data as Record<string, unknown>);
    return res.ok ? NextResponse.json({ data: res.data }, { status: 201 }) : fail(res.error, res.status);
  }

  return { GET, POST };
}

/** PATCH (update) + DELETE handlers for a single master-data row, admin-gated. */
export function makeItemRoute(opts: { table: string; updateSchema: ZodTypeAny }) {
  async function PATCH(request: Request, { params }: Ctx) {
    const auth = await apiAuth('admin');
    if (!auth.ok) return auth.response;
    const body = await request.json().catch(() => null);
    const parsed = opts.updateSchema.safeParse(body);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
    const res = await updateRow(auth.supabase, opts.table, params.id, parsed.data as Record<string, unknown>);
    return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
  }

  async function DELETE(_request: Request, { params }: Ctx) {
    const auth = await apiAuth('admin');
    if (!auth.ok) return auth.response;
    const res = await deleteRow(auth.supabase, opts.table, params.id);
    return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
  }

  return { PATCH, DELETE };
}

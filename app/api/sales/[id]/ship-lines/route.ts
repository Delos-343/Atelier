import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { shipSalesOrderLines } from '@/server/sales';
import { shipLinesSchema } from '@/schemas/sales';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = shipLinesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const res = await shipSalesOrderLines(auth.supabase, params.id, parsed.data.lines);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

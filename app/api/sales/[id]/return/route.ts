import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { createReturn } from '@/server/sales';
import { createReturnSchema } from '@/schemas/sales';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createReturnSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const res = await createReturn(auth.supabase, params.id, parsed.data.code, parsed.data.lines);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

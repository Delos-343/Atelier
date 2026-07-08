import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { completeProductionOrder } from '@/server/production';
import { completeProductionOrderSchema } from '@/schemas/production';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('production');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = completeProductionOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const result = await completeProductionOrder(
    auth.supabase,
    params.id,
    parsed.data.outputLotCode,
    parsed.data.laborHours,
    parsed.data.halalOverride,
    parsed.data.overrideReason ?? null,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ data: result.data });
}

import { NextResponse } from 'next/server';
import { completeProductionOrder } from '@/server/production';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const body = await request.json().catch(() => ({}));
  const outputLotCode = (body as { outputLotCode?: string }).outputLotCode;
  if (!outputLotCode) {
    return NextResponse.json({ error: 'outputLotCode is required' }, { status: 400 });
  }

  const result = await completeProductionOrder(params.id, outputLotCode);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result.data);
}

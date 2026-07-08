import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import {
  getProductCostingRates,
  upsertProductCostingRate,
  deleteProductCostingRate,
} from '@/server/settings';
import { productCostingRateSchema } from '@/schemas/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const res = await getProductCostingRates(auth.supabase);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function PUT(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = productCostingRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const res = await upsertProductCostingRate(auth.supabase, parsed.data);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function DELETE(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const productId = new URL(request.url).searchParams.get('productId');
  if (!productId) {
    return NextResponse.json({ error: 'A productId is required.' }, { status: 400 });
  }

  const res = await deleteProductCostingRate(auth.supabase, productId);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

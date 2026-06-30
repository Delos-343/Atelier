import { NextResponse } from 'next/server';
import { getPublicMetrics } from '@/server/public-metrics';

export const dynamic = 'force-dynamic';

// Public, unauthenticated endpoint — returns only non-sensitive aggregates.
export async function GET() {
  const metrics = await getPublicMetrics();
  if (!metrics) return NextResponse.json({ error: 'metrics unavailable' }, { status: 503 });
  return NextResponse.json({ data: metrics });
}

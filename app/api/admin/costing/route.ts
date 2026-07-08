import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getCostingSettings, updateCostingSettings } from '@/server/settings';
import { costingSettingsSchema } from '@/schemas/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const res = await getCostingSettings(auth.supabase);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function PUT(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = costingSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const res = await updateCostingSettings(auth.supabase, parsed.data);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

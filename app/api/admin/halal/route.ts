import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { getComplianceOverview, updateMaterialHalal } from '@/server/compliance';
import { updateMaterialHalalSchema } from '@/schemas/compliance';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const res = await getComplianceOverview(auth.supabase);
  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function PUT(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = updateMaterialHalalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }

  const { materialId, halalStatus, halalCertNumber, halalCertifier, halalCertExpiry } = parsed.data;
  const res = await updateMaterialHalal(auth.supabase, materialId, {
    halalStatus,
    // Coalesce absent/blank optionals to explicit nulls for the write.
    halalCertNumber: halalCertNumber ? halalCertNumber : null,
    halalCertifier: halalCertifier ? halalCertifier : null,
    halalCertExpiry: halalCertExpiry ? halalCertExpiry : null,
  });

  return res.ok
    ? NextResponse.json({ data: res.data })
    : NextResponse.json({ error: res.error }, { status: res.status });
}

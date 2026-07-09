import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { previewProductionOrder } from '@/server/production';
import { getFormulaVersionHalal } from '@/server/compliance';
import { previewProductionOrderSchema } from '@/schemas/production';

export const dynamic = 'force-dynamic';

interface MaterialRow {
  id: string;
  sku: string;
  name: string;
}

export async function POST(request: Request) {
  // Gate the preview: it returns the exploded BOM (recipe proportions), which is
  // trade-secret data that viewers must never see.
  const auth = await apiAuth('production');
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = previewProductionOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join('; ') },
      { status: 400 },
    );
  }

  const result = await previewProductionOrder(
    parsed.data.formulaVersionId,
    parsed.data.plannedQuantity,
    parsed.data.unit,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // enrich planned consumption with readable material names (reusing the authed client)
  const supabase = auth.supabase;
  const ids = result.data.map((c) => c.rawMaterialId);
  const { data: mats } = await supabase.from('raw_materials').select('id, sku, name').in('id', ids);
  const byId = new Map((((mats ?? []) as unknown) as MaterialRow[]).map((m) => [m.id, m]));

  const enriched = result.data.map((c) => ({
    rawMaterialId: c.rawMaterialId,
    sku: byId.get(c.rawMaterialId)?.sku ?? c.rawMaterialId.slice(0, 8),
    name: byId.get(c.rawMaterialId)?.name ?? '',
    quantity: c.quantity,
    unit: c.unit,
  }));

  // Flag a non-compliant recipe here, before the order exists — same rule the gate enforces.
  const halalRes = await getFormulaVersionHalal(supabase, parsed.data.formulaVersionId);

  return NextResponse.json({
    data: { components: enriched, halal: halalRes.ok ? halalRes.data : null },
  });
}

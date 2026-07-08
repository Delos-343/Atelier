import { createClient } from '@/lib/supabase/server';
import type { DbClient } from '@/lib/supabase/types';
import { logger } from '@/lib/logger';
import { explodeFormula, type FormulaInput, type ExplodedComponent } from '@/domain/formula';
import type { Unit } from '@/domain/units';
import {
  createProductionOrderSchema,
  type CreateProductionOrderDTO,
  recordQcSchema,
  type RecordQcDTO,
} from '@/schemas/production';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface DensityRow {
  density_g_per_ml: number | null;
}

/** PostgREST may return an embedded to-one relation as an object or a single-element array. */
function readDensity(rm: DensityRow | DensityRow[] | null): number | undefined {
  if (!rm) return undefined;
  const row = Array.isArray(rm) ? rm[0] : rm;
  return row?.density_g_per_ml ?? undefined;
}

/**
 * Load a formula version and explode its BOM to planned consumption for a batch,
 * WITHOUT persisting anything. Powers the production wizard's preview step.
 */
export async function previewProductionOrder(
  formulaVersionId: string,
  plannedQuantity: number,
  unit: Unit,
): Promise<ActionResult<ExplodedComponent[]>> {
  const supabase = createClient();
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  try {
    const { data: version, error: vErr } = await supabase
      .from('formula_versions')
      .select(
        'id, basis, formula_components(raw_material_id, quantity, unit, raw_materials(density_g_per_ml))',
      )
      .eq('id', formulaVersionId)
      .single();

    if (vErr || !version) {
      return { ok: false, error: `formula version not found: ${vErr?.message ?? 'missing'}` };
    }

    const components = version.formula_components ?? [];
    if (components.length === 0) {
      return { ok: false, error: 'formula version has no components' };
    }

    const formula: FormulaInput = {
      basis: version.basis,
      components: components.map((c) => ({
        rawMaterialId: c.raw_material_id,
        quantity: c.quantity,
        unit: c.unit,
        densityGPerMl: readDensity(c.raw_materials),
      })),
    };

    return { ok: true, data: explodeFormula(formula, plannedQuantity, unit) };
  } catch (err) {
    logger.error('production_order.preview_failed', { error: String(err) });
    return { ok: false, error: err instanceof Error ? err.message : 'unexpected error' };
  }
}

/**
 * Create a production order: validate, explode the BOM (via previewProductionOrder),
 * and persist the order with its planned components.
 */
export async function createProductionOrder(
  input: CreateProductionOrderDTO,
): Promise<ActionResult<{ productionOrderId: string }>> {
  const parsed = createProductionOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const dto = parsed.data;

  const preview = await previewProductionOrder(dto.formulaVersionId, dto.plannedQuantity, dto.unit);
  if (!preview.ok) return { ok: false, error: preview.error };
  const exploded = preview.data;

  const supabase = createClient();
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  try {
    const { data: po, error: poErr } = await supabase
      .from('production_orders')
      .insert({
        code: dto.code,
        product_id: dto.productId,
        formula_version_id: dto.formulaVersionId,
        warehouse_id: dto.warehouseId,
        planned_quantity: dto.plannedQuantity,
        unit: dto.unit,
      })
      .select('id')
      .single();

    if (poErr || !po) {
      return { ok: false, error: `failed to create order: ${poErr?.message ?? 'unknown'}` };
    }

    const { error: compErr } = await supabase.from('production_order_components').insert(
      exploded.map((e) => ({
        production_order_id: po.id,
        raw_material_id: e.rawMaterialId,
        // planned_quantity is a numeric column; we deliberately send a
        // precision-preserving decimal string (PostgREST coerces it). The generated
        // type expects number, so this boundary cast is intentional, not a gap.
        planned_quantity: e.quantity as unknown as number,
        unit: e.unit,
      })),
    );
    if (compErr) {
      return { ok: false, error: `failed to persist components: ${compErr.message}` };
    }

    logger.info('production_order.created', { id: po.id, components: exploded.length });
    return { ok: true, data: { productionOrderId: po.id } };
  } catch (err) {
    logger.error('production_order.create_failed', { error: String(err) });
    return { ok: false, error: err instanceof Error ? err.message : 'unexpected error' };
  }
}

/** Complete a production order atomically (FEFO consume + produce + genealogy + fully-loaded cost) via the DB function. */
export async function completeProductionOrder(
  supabase: DbClient,
  productionOrderId: string,
  outputLotCode: string,
  laborHours = 0,
  halalOverride = false,
  overrideReason: string | null = null,
): Promise<ActionResult<{ outputLotId: string }>> {
  try {
    const { data, error } = await supabase.rpc('complete_production_order', {
      p_po_id: productionOrderId,
      p_output_lot_code: outputLotCode,
      p_labor_hours: laborHours,
      p_halal_override: halalOverride,
      p_override_reason: overrideReason ?? undefined,
    });
    if (error) return { ok: false, error: error.message };
    logger.info('production_order.completed', {
      id: productionOrderId,
      outputLot: data,
      laborHours,
      halalOverride,
    });
    return { ok: true, data: { outputLotId: data as string } };
  } catch (err) {
    logger.error('production_order.complete_failed', { error: String(err) });
    return { ok: false, error: err instanceof Error ? err.message : 'unexpected error' };
  }
}

/** Record a QC result; passing releases the quarantined lot, failing rejects it. */
export async function recordQc(input: RecordQcDTO): Promise<ActionResult<null>> {
  const parsed = recordQcSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const dto = parsed.data;
  const supabase = createClient();
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  try {
    const { error } = await supabase.rpc('record_qc', {
      p_lot_id: dto.lotId,
      p_status: dto.status,
      p_sg: dto.specificGravity ?? undefined,
      p_alcohol: dto.alcoholPct ?? undefined,
      p_notes: dto.notes ?? undefined,
    });
    if (error) return { ok: false, error: error.message };
    logger.info('qc.recorded', { lotId: dto.lotId, status: dto.status });
    return { ok: true, data: null };
  } catch (err) {
    logger.error('qc.record_failed', { error: String(err) });
    return { ok: false, error: err instanceof Error ? err.message : 'unexpected error' };
  }
}

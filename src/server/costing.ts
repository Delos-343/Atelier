import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export interface CostLine {
  rawMaterialId: string;
  sku: string;
  name: string;
  consumedQuantity: number;
  unit: string;
  lineCost: number;
}

export interface ProductionOrderCost {
  code: string;
  status: string;
  outputQuantity: number;
  unit: string;
  materialCost: number; // rolled up from consumptions, frozen at completion
  laborCost: number | null; // entered hours × standard rate; null until completed
  overheadCost: number | null; // standard rate × prime cost; null until completed
  laborHours: number;
  totalCost: number; // material + labor + overhead (fully loaded)
  unitCost: number | null; // frozen onto the finished lot; null until completed
  lines: CostLine[];
}

/**
 * Cost breakdown for a production order: the frozen per-material costs (snapshotted
 * at completion), their total, and the finished lot's unit cost. Returns 404 if the
 * order doesn't exist; empty lines / null unitCost for orders not yet completed.
 */
export async function getProductionOrderCost(
  supabase: DbClient,
  poId: string,
): Promise<ServerResult<ProductionOrderCost>> {
  try {
    const { data: po, error: poErr } = await supabase
      .from('production_orders')
      .select('code, planned_quantity, unit, status, output_lot_id, labor_hours, material_cost, labor_cost, overhead_cost')
      .eq('id', poId)
      .maybeSingle();
    if (poErr) {
      return { ok: false, ...mapRpcError(poErr, { fallback: 'Failed to load production order.' }) };
    }
    if (!po) return { ok: false, error: 'Production order not found.', status: 404 };

    const { data: rows, error: costErr } = await supabase.rpc('production_order_cost', {
      p_po_id: poId,
    });
    if (costErr) {
      return { ok: false, ...mapRpcError(costErr, { fallback: 'Failed to compute cost.' }) };
    }

    // The authoritative unit cost is the value frozen onto the finished lot.
    let unitCost: number | null = null;
    if (po.output_lot_id) {
      const { data: lot } = await supabase
        .from('inventory_lots')
        .select('unit_cost')
        .eq('id', po.output_lot_id)
        .maybeSingle();
      unitCost = lot?.unit_cost ?? null;
    }

    const lines: CostLine[] = (rows ?? []).map((r) => ({
      rawMaterialId: r.raw_material_id,
      sku: r.sku,
      name: r.name,
      consumedQuantity: Number(r.consumed_quantity),
      unit: r.unit,
      lineCost: Number(r.line_cost),
    }));

    // Frozen buckets come from the order once completed; before that only the
    // (empty) material roll-up exists, so labor/overhead read as null.
    const materialCost =
      po.material_cost != null ? Number(po.material_cost) : lines.reduce((sum, l) => sum + l.lineCost, 0);
    const laborCost = po.labor_cost != null ? Number(po.labor_cost) : null;
    const overheadCost = po.overhead_cost != null ? Number(po.overhead_cost) : null;
    const totalCost = materialCost + (laborCost ?? 0) + (overheadCost ?? 0);

    return {
      ok: true,
      data: {
        code: po.code,
        status: po.status,
        outputQuantity: Number(po.planned_quantity),
        unit: po.unit,
        materialCost,
        laborCost,
        overheadCost,
        laborHours: Number(po.labor_hours ?? 0),
        totalCost,
        unitCost,
        lines,
      },
    };
  } catch (e) {
    logger.error('costing.getProductionOrderCost threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to compute cost.', status: 500 };
  }
}

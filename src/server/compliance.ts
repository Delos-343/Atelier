import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export type HalalStatus = 'certified' | 'not_certified' | 'in_review';

/** A raw material with its halal certification posture. */
export interface MaterialHalal {
  id: string;
  sku: string;
  name: string;
  category: string;
  halalStatus: HalalStatus;
  halalCertNumber: string | null;
  halalCertifier: string | null;
  halalCertExpiry: string | null; // YYYY-MM-DD
}

/** One offending component of a non-compliant formula version. */
export interface HalalOffender {
  sku: string;
  name: string;
  reason: string;
}

/** A formula version with its derived halal verdict. */
export interface FormulaVersionCompliance {
  formulaVersionId: string;
  formulaCode: string;
  formulaName: string;
  productName: string | null;
  versionNo: number;
  isLocked: boolean;
  compliant: boolean;
  offending: HalalOffender[];
}

export interface ComplianceOverview {
  materials: MaterialHalal[];
  formulaVersions: FormulaVersionCompliance[];
}

/** Narrow the JSON `offending` payload from the RPC into typed offenders. */
function toOffenders(raw: unknown): HalalOffender[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const rec = (o ?? {}) as Record<string, unknown>;
    return {
      sku: String(rec.sku ?? ''),
      name: String(rec.name ?? ''),
      reason: String(rec.reason ?? ''),
    };
  });
}

/**
 * Read the full compliance picture: every material's halal posture plus each
 * formula version's derived verdict (via the formula_versions_compliance RPC).
 */
export async function getComplianceOverview(
  supabase: DbClient,
): Promise<ServerResult<ComplianceOverview>> {
  try {
    const [materialsRes, versionsRes] = await Promise.all([
      supabase
        .from('raw_materials')
        .select('id, sku, name, category, halal_status, halal_cert_number, halal_certifier, halal_cert_expiry')
        .order('sku'),
      supabase.rpc('formula_versions_compliance'),
    ]);

    if (materialsRes.error) {
      return { ok: false, ...mapRpcError(materialsRes.error, { fallback: 'Failed to load materials.' }) };
    }
    if (versionsRes.error) {
      return {
        ok: false,
        ...mapRpcError(versionsRes.error, { fallback: 'Failed to load formula compliance.' }),
      };
    }

    const materials: MaterialHalal[] = (materialsRes.data ?? []).map((m) => ({
      id: m.id,
      sku: m.sku,
      name: m.name,
      category: m.category,
      halalStatus: m.halal_status as HalalStatus,
      halalCertNumber: m.halal_cert_number,
      halalCertifier: m.halal_certifier,
      halalCertExpiry: m.halal_cert_expiry,
    }));

    const formulaVersions: FormulaVersionCompliance[] = (versionsRes.data ?? []).map((v) => ({
      formulaVersionId: v.formula_version_id,
      formulaCode: v.formula_code,
      formulaName: v.formula_name,
      productName: v.product_name ?? null,
      versionNo: v.version_no,
      isLocked: v.is_locked,
      compliant: v.compliant,
      offending: toOffenders(v.offending),
    }));

    return { ok: true, data: { materials, formulaVersions } };
  } catch (e) {
    logger.error('compliance.getComplianceOverview threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load compliance overview.', status: 500 };
  }
}

export interface MaterialHalalInput {
  halalStatus: HalalStatus;
  halalCertNumber: string | null;
  halalCertifier: string | null;
  halalCertExpiry: string | null;
}

/**
 * Update one material's halal record (admin-only, enforced by RLS on
 * raw_materials). The DB CHECK constraint is the backstop that a certified
 * material carries a certificate number and expiry.
 */
export async function updateMaterialHalal(
  supabase: DbClient,
  id: string,
  input: MaterialHalalInput,
): Promise<ServerResult<MaterialHalal>> {
  try {
    const { data, error } = await supabase
      .from('raw_materials')
      .update({
        halal_status: input.halalStatus,
        halal_cert_number: input.halalCertNumber,
        halal_certifier: input.halalCertifier,
        halal_cert_expiry: input.halalCertExpiry,
      })
      .eq('id', id)
      .select('id, sku, name, category, halal_status, halal_cert_number, halal_certifier, halal_cert_expiry')
      .maybeSingle();

    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to update material halal status.' }) };
    }
    if (!data) return { ok: false, error: 'Material not found.', status: 404 };

    return {
      ok: true,
      data: {
        id: data.id,
        sku: data.sku,
        name: data.name,
        category: data.category,
        halalStatus: data.halal_status as HalalStatus,
        halalCertNumber: data.halal_cert_number,
        halalCertifier: data.halal_certifier,
        halalCertExpiry: data.halal_cert_expiry,
      },
    };
  } catch (e) {
    logger.error('compliance.updateMaterialHalal threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to update material halal status.', status: 500 };
  }
}

/** A production order's halal verdict — the same check the completion gate enforces. */
export interface HalalVerdict {
  compliant: boolean;
  offending: HalalOffender[];
}

/**
 * Evaluate a production order's formula version against the halal rules, as of today —
 * exactly what `complete_production_order` enforces at completion. Empty `offending`
 * means compliant. Returns 404 if the order is unknown. Read-only and RLS-governed;
 * this surfaces the verdict so the block is visible before completion is attempted.
 */
export async function getProductionOrderHalal(
  supabase: DbClient,
  productionOrderId: string,
): Promise<ServerResult<HalalVerdict>> {
  try {
    const { data: po, error: poErr } = await supabase
      .from('production_orders')
      .select('formula_version_id')
      .eq('id', productionOrderId)
      .maybeSingle();
    if (poErr) {
      return { ok: false, ...mapRpcError(poErr, { fallback: 'Failed to load production order.' }) };
    }
    if (!po) return { ok: false, error: 'Production order not found.', status: 404 };

    const { data, error } = await supabase.rpc('formula_version_halal_noncompliance', {
      p_formula_version_id: po.formula_version_id,
    });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to evaluate halal compliance.' }) };
    }

    const offending = toOffenders(data);
    return { ok: true, data: { compliant: offending.length === 0, offending } };
  } catch (e) {
    logger.error('compliance.getProductionOrderHalal threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to evaluate halal compliance.', status: 500 };
  }
}

/**
 * Evaluate a formula version's halal verdict directly — no production order needed. The
 * new-order wizard calls this (via the preview endpoint) so a non-compliant recipe is
 * flagged before the order exists, using the same rules the completion gate enforces.
 */
export async function getFormulaVersionHalal(
  supabase: DbClient,
  formulaVersionId: string,
): Promise<ServerResult<HalalVerdict>> {
  try {
    const { data, error } = await supabase.rpc('formula_version_halal_noncompliance', {
      p_formula_version_id: formulaVersionId,
    });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to evaluate halal compliance.' }) };
    }
    const offending = toOffenders(data);
    return { ok: true, data: { compliant: offending.length === 0, offending } };
  } catch (e) {
    logger.error('compliance.getFormulaVersionHalal threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to evaluate halal compliance.', status: 500 };
  }
}

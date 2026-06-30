import type { DbClient } from '@/lib/supabase/types';
import { logger } from '@/lib/logger';
import type { ComponentInput } from '@/schemas/formula-admin';
import { mapRpcError, type PgLikeError, type ServerResult } from './pg-error';

export type FxResult<T> = ServerResult<T>;

/**
 * Map errors from the formula RPCs (and their underlying constraints) to HTTP.
 * Formula-specific constraint codes are handled here; the shared status-code
 * contract (42501 / P0002 / P0001 / default) is delegated to mapRpcError.
 */
function mapFx(error: PgLikeError | null, fallback: string): { error: string; status: number } {
  switch (error?.code) {
    case '23514': // check_violation: empty lock / percent sum
      return { error: error?.message ?? 'Validation failed.', status: 422 };
    case '23505': // unique_violation: duplicate material in a version
      return { error: 'That material is already in this version.', status: 409 };
    case '23503': // fk_violation: version referenced by a production order
      return {
        error: 'This version is used by a production order, so it can’t be removed.',
        status: 409,
      };
    default:
      if (error?.message?.toLowerCase().includes('row-level security')) {
        return { error: 'You don’t have permission to perform this action.', status: 403 };
      }
      return mapRpcError(error, {
        fallback,
        forbidden: 'You don’t have permission to perform this action.',
        notAllowed: 'This action isn’t allowed.',
      });
  }
}

export interface FormulaListItem {
  id: string;
  code: string;
  name: string;
  product: { sku: string; name: string } | null;
  versionCount: number;
  latest: { versionNo: number; isLocked: boolean } | null;
}

export interface FormulaComponentDetail {
  id: string;
  rawMaterialId: string;
  material: { sku: string; name: string; baseUnit: string } | null;
  quantity: number;
  unit: string;
  sequence: number;
}

export interface FormulaVersionDetail {
  id: string;
  versionNo: number;
  basis: 'percent' | 'mass';
  isLocked: boolean;
  createdAt: string;
  components: FormulaComponentDetail[];
}

export interface FormulaDetail {
  id: string;
  code: string;
  name: string;
  productId: string;
  product: { sku: string; name: string } | null;
  versions: FormulaVersionDetail[];
}

// PostgREST hands back to-one embeds as an object and to-many as an array, but
// the untyped client types them loosely — normalize defensively.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export async function listFormulas(supabase: DbClient): Promise<FxResult<FormulaListItem[]>> {
  try {
    const { data, error } = await supabase
      .from('formulas')
      .select('id, code, name, products(sku,name), formula_versions(version_no,is_locked)')
      .order('code', { ascending: true });
    if (error) {
      logger.error('formulas.list failed', { code: error.code });
      return { ok: false, ...mapFx(error, 'Failed to load formulas.') };
    }
    const items: FormulaListItem[] = (data ?? []).map((f) => {
      const versions = f.formula_versions ?? [];
      const latest = versions.length
        ? versions.reduce((a, b) => (b.version_no > a.version_no ? b : a))
        : null;
      const product = one(f.products);
      return {
        id: f.id,
        code: f.code,
        name: f.name,
        product,
        versionCount: versions.length,
        latest: latest ? { versionNo: latest.version_no, isLocked: latest.is_locked } : null,
      };
    });
    return { ok: true, data: items };
  } catch (e) {
    logger.error('formulas.list threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function getFormulaDetail(
  supabase: DbClient,
  id: string,
): Promise<FxResult<FormulaDetail>> {
  try {
    const { data, error } = await supabase
      .from('formulas')
      .select(
        'id, code, name, product_id, products(sku,name), ' +
          'formula_versions(id,version_no,basis,is_locked,created_at,' +
          'formula_components(id,raw_material_id,quantity,unit,sequence,raw_materials(sku,name,base_unit)))',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) {
      logger.error('formulas.detail failed', { code: error.code });
      return { ok: false, ...mapFx(error, 'Failed to load formula.') };
    }
    if (!data) return { ok: false, error: 'Formula not found.', status: 404 };

    // supabase-js can't infer this 4-level nested embed — its select-string typing
    // bottoms out in GenericStringError at this depth — so we assert the known shape
    // once and map from it with full typing, rather than casting field by field.
    type FormulaDetailRow = {
      id: string;
      code: string;
      name: string;
      product_id: string;
      products: { sku: string; name: string } | null;
      formula_versions: Array<{
        id: string;
        version_no: number;
        basis: 'percent' | 'mass';
        is_locked: boolean;
        created_at: string;
        formula_components: Array<{
          id: string;
          raw_material_id: string;
          quantity: number;
          unit: string;
          sequence: number | null;
          raw_materials: { sku: string; name: string; base_unit: string } | null;
        }>;
      }>;
    };
    const row = data as unknown as FormulaDetailRow;

    const versions: FormulaVersionDetail[] = (row.formula_versions ?? [])
      .map((v) => {
        const components: FormulaComponentDetail[] = (v.formula_components ?? [])
          .map((c) => {
            const mat = one(c.raw_materials);
            return {
              id: c.id,
              rawMaterialId: c.raw_material_id,
              material: mat ? { sku: mat.sku, name: mat.name, baseUnit: mat.base_unit } : null,
              quantity: Number(c.quantity),
              unit: c.unit,
              sequence: c.sequence ?? 0,
            };
          })
          .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
        return {
          id: v.id,
          versionNo: v.version_no,
          basis: v.basis,
          isLocked: v.is_locked,
          createdAt: v.created_at,
          components,
        };
      })
      .sort((a, b) => a.versionNo - b.versionNo);

    const product = one(row.products);
    return {
      ok: true,
      data: {
        id: row.id,
        code: row.code,
        name: row.name,
        productId: row.product_id,
        product,
        versions,
      },
    };
  } catch (e) {
    logger.error('formulas.detail threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function createVersion(
  supabase: DbClient,
  input: { formulaId: string; basis: 'percent' | 'mass'; cloneFromVersionId?: string | null },
): Promise<FxResult<{ id: string }>> {
  try {
    const { data, error } = await supabase.rpc('admin_create_formula_version', {
      p_formula_id: input.formulaId,
      p_basis: input.basis,
      p_clone_from: input.cloneFromVersionId ?? undefined,
    });
    if (error) {
      logger.error('formulas.createVersion failed', { code: error.code });
      return { ok: false, ...mapFx(error, 'Failed to create version.') };
    }
    return { ok: true, data: { id: data as string } };
  } catch (e) {
    logger.error('formulas.createVersion threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function saveVersion(
  supabase: DbClient,
  vid: string,
  components: ComponentInput[],
  lock: boolean,
): Promise<FxResult<{ id: string; locked: boolean }>> {
  try {
    const { error } = await supabase.rpc('admin_save_formula_version', {
      p_vid: vid,
      p_components: components,
      p_lock: lock,
    });
    if (error) {
      logger.error('formulas.saveVersion failed', { code: error.code });
      return { ok: false, ...mapFx(error, 'Failed to save version.') };
    }
    return { ok: true, data: { id: vid, locked: lock } };
  } catch (e) {
    logger.error('formulas.saveVersion threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function deleteVersion(
  supabase: DbClient,
  vid: string,
): Promise<FxResult<{ id: string }>> {
  try {
    const { error } = await supabase.rpc('admin_delete_formula_version', { p_vid: vid });
    if (error) {
      logger.error('formulas.deleteVersion failed', { code: error.code });
      return { ok: false, ...mapFx(error, 'Failed to delete version.') };
    }
    return { ok: true, data: { id: vid } };
  } catch (e) {
    logger.error('formulas.deleteVersion threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

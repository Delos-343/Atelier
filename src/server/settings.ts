import type { DbClient } from '@/lib/supabase/types';
import { mapRpcError, type ServerResult } from './pg-error';
import { logger } from '@/lib/logger';

export interface CostingSettings {
  laborRatePerHour: number;
  overheadRate: number; // fraction of prime cost (material + labor)
  updatedAt: string | null;
}

/** Read the singleton costing-rates row (defaults to zeros if somehow missing). */
export async function getCostingSettings(supabase: DbClient): Promise<ServerResult<CostingSettings>> {
  try {
    const { data, error } = await supabase
      .from('costing_settings')
      .select('labor_rate_per_hour, overhead_rate, updated_at')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load costing settings.' }) };
    }
    return {
      ok: true,
      data: {
        laborRatePerHour: Number(data?.labor_rate_per_hour ?? 0),
        overheadRate: Number(data?.overhead_rate ?? 0),
        updatedAt: data?.updated_at ?? null,
      },
    };
  } catch (e) {
    logger.error('settings.getCostingSettings threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load costing settings.', status: 500 };
  }
}

/** Update the singleton costing-rates row (admin-only, enforced by RLS). */
export async function updateCostingSettings(
  supabase: DbClient,
  input: { laborRatePerHour: number; overheadRate: number },
): Promise<ServerResult<CostingSettings>> {
  try {
    const { data, error } = await supabase
      .from('costing_settings')
      .update({
        labor_rate_per_hour: input.laborRatePerHour,
        overhead_rate: input.overheadRate,
        updated_at: new Date().toISOString(),
      })
      .eq('id', true)
      .select('labor_rate_per_hour, overhead_rate, updated_at')
      .maybeSingle();
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to update costing settings.' }) };
    }
    if (!data) return { ok: false, error: 'Costing settings row is missing.', status: 500 };
    return {
      ok: true,
      data: {
        laborRatePerHour: Number(data.labor_rate_per_hour),
        overheadRate: Number(data.overhead_rate),
        updatedAt: data.updated_at,
      },
    };
  } catch (e) {
    logger.error('settings.updateCostingSettings threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to update costing settings.', status: 500 };
  }
}

export interface TaxSettings {
  ppnRate: number; // VAT/PPN as a percentage, e.g. 11 = 11%
  updatedAt: string | null;
}

/** Read the singleton tax-settings row (defaults to 0 if somehow missing). */
export async function getTaxSettings(supabase: DbClient): Promise<ServerResult<TaxSettings>> {
  try {
    const { data, error } = await supabase
      .from('tax_settings')
      .select('ppn_rate, updated_at')
      .eq('id', true)
      .maybeSingle();
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load tax settings.' }) };
    }
    return {
      ok: true,
      data: { ppnRate: Number(data?.ppn_rate ?? 0), updatedAt: data?.updated_at ?? null },
    };
  } catch (e) {
    logger.error('settings.getTaxSettings threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Failed to load tax settings.', status: 500 };
  }
}

/** Update the singleton tax-settings row (admin-only, enforced by RLS). */
export async function updateTaxSettings(
  supabase: DbClient,
  input: { ppnRate: number },
): Promise<ServerResult<TaxSettings>> {
  try {
    const { data, error } = await supabase
      .from('tax_settings')
      .update({ ppn_rate: input.ppnRate, updated_at: new Date().toISOString() })
      .eq('id', true)
      .select('ppn_rate, updated_at')
      .maybeSingle();
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to update tax settings.' }) };
    }
    if (!data) return { ok: false, error: 'Tax settings row is missing.', status: 500 };
    return { ok: true, data: { ppnRate: Number(data.ppn_rate), updatedAt: data.updated_at } };
  } catch (e) {
    logger.error('settings.updateTaxSettings threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to update tax settings.', status: 500 };
  }
}

/**
 * A per-product override of the plant-wide rates. Either field may be null, meaning
 * "inherit the plant-wide standard for this one"; a row exists only when a product
 * overrides at least one rate.
 */
export interface ProductCostingRate {
  productId: string;
  sku: string;
  name: string;
  laborRatePerHour: number | null; // null = inherit plant-wide
  overheadRate: number | null; // fraction of prime cost; null = inherit plant-wide
  updatedAt: string | null;
}

/** Embedded product may arrive as an object or a single-element array depending on typegen. */
function embeddedProduct(p: unknown): { sku?: string; name?: string } {
  if (Array.isArray(p)) return (p[0] as { sku?: string; name?: string }) ?? {};
  return (p as { sku?: string; name?: string }) ?? {};
}

function mapRate(row: {
  product_id: string;
  labor_rate_per_hour: number | string | null;
  overhead_rate: number | string | null;
  updated_at: string | null;
  products: unknown;
}): ProductCostingRate {
  const prod = embeddedProduct(row.products);
  return {
    productId: row.product_id,
    sku: prod.sku ?? '',
    name: prod.name ?? '',
    laborRatePerHour: row.labor_rate_per_hour === null ? null : Number(row.labor_rate_per_hour),
    overheadRate: row.overhead_rate === null ? null : Number(row.overhead_rate),
    updatedAt: row.updated_at ?? null,
  };
}

const RATE_SELECT = 'product_id, labor_rate_per_hour, overhead_rate, updated_at, products(sku, name)';

/** List every per-product override, newest first, with its product's sku/name. */
export async function getProductCostingRates(
  supabase: DbClient,
): Promise<ServerResult<ProductCostingRate[]>> {
  try {
    const { data, error } = await supabase
      .from('product_costing_rates')
      .select(RATE_SELECT)
      .order('updated_at', { ascending: false });
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to load product rates.' }) };
    }
    return { ok: true, data: (data ?? []).map((r) => mapRate(r as never)) };
  } catch (e) {
    logger.error('settings.getProductCostingRates threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to load product rates.', status: 500 };
  }
}

/** Create or update one product's override (admin-only, enforced by RLS). */
export async function upsertProductCostingRate(
  supabase: DbClient,
  input: { productId: string; laborRatePerHour: number | null; overheadRate: number | null },
): Promise<ServerResult<ProductCostingRate>> {
  try {
    const { data, error } = await supabase
      .from('product_costing_rates')
      .upsert(
        {
          product_id: input.productId,
          labor_rate_per_hour: input.laborRatePerHour,
          overhead_rate: input.overheadRate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'product_id' },
      )
      .select(RATE_SELECT)
      .maybeSingle();
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to save product rate.' }) };
    }
    if (!data) return { ok: false, error: 'Product rate did not save.', status: 500 };
    return { ok: true, data: mapRate(data as never) };
  } catch (e) {
    logger.error('settings.upsertProductCostingRate threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to save product rate.', status: 500 };
  }
}

/** Remove a product's override so it inherits the plant-wide rates again. */
export async function deleteProductCostingRate(
  supabase: DbClient,
  productId: string,
): Promise<ServerResult<{ productId: string }>> {
  try {
    const { error } = await supabase
      .from('product_costing_rates')
      .delete()
      .eq('product_id', productId);
    if (error) {
      return { ok: false, ...mapRpcError(error, { fallback: 'Failed to remove product rate.' }) };
    }
    return { ok: true, data: { productId } };
  } catch (e) {
    logger.error('settings.deleteProductCostingRate threw', {
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: 'Failed to remove product rate.', status: 500 };
  }
}

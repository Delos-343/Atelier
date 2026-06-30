import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { ServerResult } from './pg-error';

export type CrudResult<T> = ServerResult<T>;

interface PgError {
  code?: string;
  message?: string;
  details?: string;
}

/** Map a Postgres/PostgREST error to a friendly message + HTTP status. */
function mapError(error: PgError | null, fallback: string): { error: string; status: number } {
  const code = error?.code;
  switch (code) {
    case '23505': // unique_violation
      return { error: 'A record with that unique value already exists.', status: 409 };
    case '23503': // foreign_key_violation
      return {
        error: 'This record is referenced by other data, so it can’t be changed or removed.',
        status: 409,
      };
    case '23502': // not_null_violation
      return { error: 'A required field is missing.', status: 400 };
    case '23514': // check_violation
      return { error: 'A value failed a database constraint.', status: 422 };
    case '42501': // insufficient_privilege (RLS)
      return { error: 'You don’t have permission to perform this action.', status: 403 };
    default:
      if (error?.message?.toLowerCase().includes('row-level security')) {
        return { error: 'You don’t have permission to perform this action.', status: 403 };
      }
      return { error: error?.message ?? fallback, status: 500 };
  }
}

export async function listRows<T = unknown>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderBy = 'created_at',
): Promise<CrudResult<T[]>> {
  try {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true });
    if (error) {
      logger.error('crud.list failed', { table, code: error.code });
      const m = mapError(error, 'Failed to load records.');
      return { ok: false, ...m };
    }
    return { ok: true, data: (data ?? []) as T[] };
  } catch (e) {
    logger.error('crud.list threw', { table, message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function createRow<T = unknown>(
  supabase: SupabaseClient,
  table: string,
  values: Record<string, unknown>,
): Promise<CrudResult<T>> {
  try {
    const { data, error } = await supabase.from(table).insert(values).select().single();
    if (error) {
      logger.error('crud.create failed', { table, code: error.code });
      const m = mapError(error, 'Failed to create record.');
      return { ok: false, ...m };
    }
    return { ok: true, data: data as T };
  } catch (e) {
    logger.error('crud.create threw', { table, message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function updateRow<T = unknown>(
  supabase: SupabaseClient,
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<CrudResult<T>> {
  if (Object.keys(values).length === 0) {
    return { ok: false, error: 'No fields to update.', status: 400 };
  }
  try {
    const { data, error } = await supabase
      .from(table)
      .update(values)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) {
      logger.error('crud.update failed', { table, code: error.code });
      const m = mapError(error, 'Failed to update record.');
      return { ok: false, ...m };
    }
    if (!data) return { ok: false, error: 'Record not found.', status: 404 };
    return { ok: true, data: data as T };
  } catch (e) {
    logger.error('crud.update threw', { table, message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function deleteRow(
  supabase: SupabaseClient,
  table: string,
  id: string,
): Promise<CrudResult<{ id: string }>> {
  try {
    const { error, count } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .eq('id', id);
    if (error) {
      logger.error('crud.delete failed', { table, code: error.code });
      const m = mapError(error, 'Failed to delete record.');
      return { ok: false, ...m };
    }
    if (!count) return { ok: false, error: 'Record not found.', status: 404 };
    return { ok: true, data: { id } };
  } catch (e) {
    logger.error('crud.delete threw', { table, message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

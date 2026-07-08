import type { DbClient } from '@/lib/supabase/types';
import { logger } from '@/lib/logger';
import type { AppRole } from '@/lib/auth/session';
import { mapRpcError, type PgLikeError, type ServerResult } from './pg-error';

export type UserResult<T> = ServerResult<T>;

export interface AdminUser {
  user_id: string;
  email: string | null;
  role: AppRole;
  has_override: boolean;
  created_at: string;
}

const mapErr = (error: PgLikeError | null, fallback: string) =>
  mapRpcError(error, { fallback, forbidden: 'Admin clearance required.', notFound: 'No such user.' });

export async function listUsers(supabase: DbClient): Promise<UserResult<AdminUser[]>> {
  try {
    const { data, error } = await supabase.rpc('admin_list_users');
    if (error) {
      logger.error('users.list failed', { code: error.code });
      return { ok: false, ...mapErr(error, 'Failed to list users.') };
    }
    return { ok: true, data: data ?? [] };
  } catch (e) {
    logger.error('users.list threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function setUserRole(
  supabase: DbClient,
  target: string,
  role: AppRole,
): Promise<UserResult<null>> {
  try {
    const { error } = await supabase.rpc('admin_set_user_role', { target, new_role: role });
    if (error) {
      logger.error('users.setRole failed', { code: error.code });
      return { ok: false, ...mapErr(error, 'Failed to set role.') };
    }
    return { ok: true, data: null };
  } catch (e) {
    logger.error('users.setRole threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

export async function revokeUser(
  supabase: DbClient,
  target: string,
): Promise<UserResult<null>> {
  try {
    const { error } = await supabase.rpc('admin_revoke_user', { target });
    if (error) {
      logger.error('users.revoke failed', { code: error.code });
      return { ok: false, ...mapErr(error, 'Failed to revoke user.') };
    }
    return { ok: true, data: null };
  } catch (e) {
    logger.error('users.revoke threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Database unreachable.', status: 502 };
  }
}

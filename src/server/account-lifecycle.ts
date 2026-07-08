import type { DbClient } from '@/lib/supabase/types';
import { logger } from '@/lib/logger';
import type { AppRole } from '@/lib/auth/session';
import { mapRpcError, type PgLikeError, type ServerResult } from './pg-error';

export type AccountResult<T> = ServerResult<T>;

interface AuthLikeError {
  status?: number;
  message?: string;
  code?: string;
}

/** Errors from the guard RPC (admin_check_user_deletable) → HTTP, matching the other admin RPCs. */
const mapGuard = (error: PgLikeError | null, fallback: string) =>
  mapRpcError(error, { fallback, forbidden: 'Admin clearance required.', notFound: 'No such user.' });

/**
 * Errors from the Supabase Auth Admin API → HTTP. These carry an HTTP-ish `status`
 * and a `message`/`code`; normalize the cases a user can actually cause (duplicate
 * email, weak/invalid password) to honest, friendly status codes.
 */
function mapAuth(error: AuthLikeError | null, fallback: string): { error: string; status: number } {
  const message = error?.message ?? fallback;
  const lc = message.toLowerCase();
  if (
    error?.code === 'email_exists' ||
    error?.code === 'user_already_exists' ||
    (lc.includes('already') && (lc.includes('registered') || lc.includes('exist')))
  ) {
    return { error: 'A user with that email already exists.', status: 409 };
  }
  if (lc.includes('password')) {
    return { error: message, status: 422 };
  }
  const status =
    typeof error?.status === 'number' && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
  return { error: message, status };
}

/**
 * Assign a freshly provisioned user's initial role. 'viewer' is the default and
 * deliberately leaves no app_users override row. Returns an error result to bubble
 * up on failure (the account already exists, so it's recoverable from the list), or
 * null on success.
 */
async function assignInitialRole(
  admin: DbClient,
  userId: string,
  role: AppRole,
  doneLabel: string,
): Promise<{ ok: false; error: string; status: number } | null> {
  if (role === 'viewer') return null;
  const { error } = await admin
    .from('app_users')
    .upsert({ user_id: userId, role }, { onConflict: 'user_id' });
  if (error) {
    logger.error('account.assignRole failed', { code: error.code, label: doneLabel });
    return {
      ok: false,
      error: `${doneLabel}, but the role could not be set — assign it from the list.`,
      status: 500,
    };
  }
  return null;
}

/**
 * Create a login account (service-role) with a password, and assign its initial
 * role. `admin` must be the service-role client; the caller's admin status is
 * verified at the route level before this runs.
 */
export async function createAccount(
  admin: DbClient,
  input: { email: string; password: string; role: AppRole },
): Promise<AccountResult<{ id: string; email: string }>> {
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true, // usable immediately; no confirmation email round-trip
    });
    if (error || !data?.user) {
      logger.error('account.create failed', { code: (error as AuthLikeError | null)?.code });
      return { ok: false, ...mapAuth(error as AuthLikeError | null, 'Failed to create user.') };
    }

    const userId = data.user.id;
    const roleError = await assignInitialRole(admin, userId, input.role, 'Account created');
    if (roleError) return roleError;

    return { ok: true, data: { id: userId, email: input.email } };
  } catch (e) {
    logger.error('account.create threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Auth service unreachable.', status: 502 };
  }
}

/**
 * Invite a user by email (service-role). Supabase emails an invitation link; the
 * invitee sets their own password on /accept-invite. Requires SMTP configured on
 * the Supabase project, and `redirectTo` must be an allowed redirect URL in the
 * project's auth settings. Role assignment is identical to createAccount.
 */
export async function inviteAccount(
  admin: DbClient,
  input: { email: string; role: AppRole; redirectTo?: string },
): Promise<AccountResult<{ id: string; email: string }>> {
  try {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
      redirectTo: input.redirectTo,
    });
    if (error || !data?.user) {
      logger.error('account.invite failed', { code: (error as AuthLikeError | null)?.code });
      return { ok: false, ...mapAuth(error as AuthLikeError | null, 'Failed to send invitation.') };
    }

    const userId = data.user.id;
    const roleError = await assignInitialRole(admin, userId, input.role, 'Invitation sent');
    if (roleError) return roleError;

    return { ok: true, data: { id: userId, email: input.email } };
  } catch (e) {
    logger.error('account.invite threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Auth service unreachable.', status: 502 };
  }
}

/**
 * Delete a login account. Order matters: the guards (admin gate, not-self,
 * not-last-admin) run first in the caller's context via admin_check_user_deletable;
 * only then does the service-role client delete the auth user; finally the
 * app_users row is cleaned up (no FK cascade). A guard failure leaves everything
 * untouched.
 */
export async function deleteAccount(
  authed: DbClient,
  admin: DbClient,
  targetId: string,
): Promise<AccountResult<{ id: string; email: string | null }>> {
  try {
    const { data: email, error: guardErr } = await authed.rpc('admin_check_user_deletable', {
      p_user_id: targetId,
    });
    if (guardErr) {
      logger.error('account.delete guard rejected', { code: guardErr.code });
      return { ok: false, ...mapGuard(guardErr, 'Cannot delete this user.') };
    }

    const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
    if (delErr) {
      logger.error('account.delete failed', { code: (delErr as AuthLikeError | null)?.code });
      return { ok: false, ...mapAuth(delErr as AuthLikeError | null, 'Failed to delete user.') };
    }

    // Remove the role mapping. app_users has no FK to auth.users, so this won't
    // cascade — and leaving an orphaned 'admin' row would corrupt the last-admin
    // count. The login is already gone, so a failure here is cosmetic but logged.
    const { error: cleanupErr } = await admin.from('app_users').delete().eq('user_id', targetId);
    if (cleanupErr) {
      logger.error('account.delete cleanup failed', { code: cleanupErr.code });
    }

    return { ok: true, data: { id: targetId, email: email ?? null } };
  } catch (e) {
    logger.error('account.delete threw', { message: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'Auth service unreachable.', status: 502 };
  }
}

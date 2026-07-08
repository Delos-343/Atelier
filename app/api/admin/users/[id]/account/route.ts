import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { deleteAccount } from '@/server/account-lifecycle';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Permanently delete a login account (auth.users + its role mapping).
 * Distinct from `DELETE /api/admin/users/[id]`, which only removes the role
 * override and leaves the login intact.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const admin = createAdminClient();
  if (!admin) {
    return fail(
      'Account deletion requires the service-role key (SUPABASE_SERVICE_ROLE_KEY) to be configured on the server.',
      503,
    );
  }

  const res = await deleteAccount(auth.supabase, admin, params.id);
  return res.ok ? NextResponse.json({ data: res.data }) : fail(res.error, res.status);
}

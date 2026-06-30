import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { listUsers } from '@/server/users';
import { createAccount, inviteAccount } from '@/server/account-lifecycle';
import { createAdminClient, isAccountManagementConfigured } from '@/lib/supabase/admin';
import { createUserSchema, inviteUserSchema } from '@/schemas/account';

export const dynamic = 'force-dynamic';

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET() {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;
  const res = await listUsers(auth.supabase);
  if (!res.ok) return fail(res.error, res.status);
  // canManageAccounts tells the UI whether the service-role key is configured, so
  // it can show or hide the create/delete-account controls accordingly.
  return NextResponse.json({
    data: { users: res.data, canManageAccounts: isAccountManagementConfigured() },
  });
}

export async function POST(request: Request) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const admin = createAdminClient();
  if (!admin) {
    return fail(
      'Account creation requires the service-role key (SUPABASE_SERVICE_ROLE_KEY) to be configured on the server.',
      503,
    );
  }

  const body = (await request.json().catch(() => null)) as { mode?: string } | null;

  // Email-invitation path: Supabase sends a link, the invitee sets their own
  // password on /accept-invite. The default (no mode / 'password') is unchanged.
  if (body?.mode === 'invite') {
    const parsed = inviteUserSchema.safeParse(body);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
    const res = await inviteAccount(admin, { ...parsed.data, redirectTo: `${origin}/accept-invite` });
    return res.ok ? NextResponse.json({ data: res.data }, { status: 201 }) : fail(res.error, res.status);
  }

  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid input.', 400);
  const res = await createAccount(admin, parsed.data);
  return res.ok ? NextResponse.json({ data: res.data }, { status: 201 }) : fail(res.error, res.status);
}

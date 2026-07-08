import { NextResponse } from 'next/server';
import { apiAuth } from '@/lib/auth/api-guard';
import { setUserRole, revokeUser } from '@/server/users';
import type { AppRole } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const ROLES: AppRole[] = ['admin', 'production', 'qc', 'viewer'];

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => null)) as { role?: string } | null;
  const role = body?.role;
  if (!role || !ROLES.includes(role as AppRole)) {
    return NextResponse.json({ error: 'role must be one of: admin, production, qc, viewer.' }, { status: 400 });
  }

  const res = await setUserRole(auth.supabase, params.id, role as AppRole);
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: res.status });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await apiAuth('admin');
  if (!auth.ok) return auth.response;

  const res = await revokeUser(auth.supabase, params.id);
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: res.error }, { status: res.status });
}

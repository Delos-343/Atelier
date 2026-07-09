'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../components/auth/SessionProvider';
import { api, errMsg } from '@/lib/api-client';

type AppRole = 'admin' | 'production' | 'qc' | 'viewer';

interface AdminUser {
  user_id: string;
  email: string | null;
  role: AppRole;
  has_override: boolean;
  created_at: string;
}

interface UsersPayload {
  users: AdminUser[];
  canManageAccounts: boolean;
}

const ROLES: AppRole[] = ['admin', 'production', 'qc', 'viewer'];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export function UserManager() {
  const { user } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  // create-account form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ email: string; password: string; role: AppRole }>({
    email: '',
    password: '',
    role: 'viewer',
  });
  const [createBusy, setCreateBusy] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [provisionMode, setProvisionMode] = useState<'password' | 'invite'>('password');

  // Foreground load shows the skeleton; background reloads (after create/delete)
  // refresh silently so the form and table don't flash.
  const load = useCallback(async (opts?: { background?: boolean }) => {
    if (!opts?.background) setLoading(true);
    setError(null);
    try {
      const data = await api<UsersPayload>('/api/admin/users');
      setUsers(data?.users ?? []);
      setCanManage(Boolean(data?.canManageAccounts));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      if (!opts?.background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (target: AdminUser, role: AppRole) => {
    if (role === target.role && target.has_override) return;
    setBusyId(target.user_id);
    setRowError(null);
    const prev = users;
    setUsers((list) =>
      list.map((u) => (u.user_id === target.user_id ? { ...u, role, has_override: true } : u)),
    );
    try {
      await api(`/api/admin/users/${target.user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    } catch (e) {
      setUsers(prev);
      setRowError({ id: target.user_id, message: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  const removeOverride = async (target: AdminUser) => {
    setBusyId(target.user_id);
    setRowError(null);
    const prev = users;
    setUsers((list) =>
      list.map((u) =>
        u.user_id === target.user_id ? { ...u, role: 'viewer', has_override: false } : u,
      ),
    );
    try {
      await api(`/api/admin/users/${target.user_id}`, { method: 'DELETE' });
    } catch (e) {
      setUsers(prev);
      setRowError({ id: target.user_id, message: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  const removeAccount = async (target: AdminUser) => {
    const label = target.email ?? target.user_id;
    if (
      !window.confirm(
        `Permanently delete the account for ${label}? This removes their login and cannot be undone.`,
      )
    ) {
      return;
    }
    setBusyId(target.user_id);
    setRowError(null);
    try {
      await api(`/api/admin/users/${target.user_id}/account`, { method: 'DELETE' });
      await load({ background: true });
    } catch (e) {
      setRowError({ id: target.user_id, message: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  const submitCreate = async () => {
    setCreateMsg(null);
    if (!form.email.trim()) {
      setCreateMsg({ kind: 'bad', text: 'Email is required.' });
      return;
    }
    if (provisionMode === 'password' && !form.password) {
      setCreateMsg({ kind: 'bad', text: 'A temporary password is required.' });
      return;
    }
    setCreateBusy(true);
    try {
      const payload =
        provisionMode === 'invite'
          ? { mode: 'invite', email: form.email.trim(), role: form.role }
          : { mode: 'password', email: form.email.trim(), password: form.password, role: form.role };
      const created = await api<{ id: string; email: string }>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setCreateMsg({
        kind: 'ok',
        text:
          provisionMode === 'invite'
            ? `Invitation sent to ${created.email}.`
            : `Created ${created.email}.`,
      });
      setForm({ email: '', password: '', role: 'viewer' });
      await load({ background: true });
    } catch (e) {
      setCreateMsg({ kind: 'bad', text: errMsg(e) });
    } finally {
      setCreateBusy(false);
    }
  };

  if (loading) return <p className="text-muted">Loading users…</p>;

  if (error) {
    return (
      <div>
        <p className="mb-3 rounded border border-bad bg-surface px-3 py-2 text-[0.85rem] text-bad">
          {error}
        </p>
        <button className="btn btn-sm btn-ghost" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {/* Account management: create form, or a notice when the service-role key is absent */}
      {canManage ? (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="section-label">Accounts</span>
            <button
              className="btn btn-sm"
              onClick={() => {
                setShowCreate((v) => !v);
                setCreateMsg(null);
              }}
            >
              {showCreate ? 'Cancel' : 'New user'}
            </button>
          </div>
          {showCreate && (
            <div className="card grid gap-3">
              {/* Provisioning method */}
              <div className="flex gap-1 rounded border border-border p-1 text-[0.82rem]">
                <button
                  type="button"
                  className={`flex-1 rounded px-2 py-1 transition-colors ${
                    provisionMode === 'password' ? 'bg-surface-2 text-text' : 'text-muted'
                  }`}
                  onClick={() => {
                    setProvisionMode('password');
                    setCreateMsg(null);
                  }}
                >
                  Temporary password
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded px-2 py-1 transition-colors ${
                    provisionMode === 'invite' ? 'bg-surface-2 text-text' : 'text-muted'
                  }`}
                  onClick={() => {
                    setProvisionMode('invite');
                    setCreateMsg(null);
                  }}
                >
                  Email invitation
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block sm:col-span-2">
                  <span className="label">
                    Email<span className="text-bad"> *</span>
                  </span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="off"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="person@company.com"
                  />
                </label>
                <label className="block">
                  <span className="label">Initial role</span>
                  <select
                    className="input"
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {provisionMode === 'password' ? (
                <label className="block">
                  <span className="label">
                    Temporary password<span className="text-bad"> *</span>
                  </span>
                  <input
                    className="input"
                    type="text"
                    autoComplete="off"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="at least 8 characters"
                  />
                  <span className="mt-1 block text-[0.78rem] text-muted">
                    Share this with the user; they can change it after signing in.
                  </span>
                </label>
              ) : (
                <p className="text-[0.78rem] text-muted">
                  An invitation email will be sent; the user follows the link to set their own
                  password. Requires email (SMTP) configured on your Supabase project, and{' '}
                  <span className="mono">/accept-invite</span> added to its allowed redirect URLs.
                </p>
              )}

              {createMsg && (
                <p className={`text-[0.85rem] ${createMsg.kind === 'ok' ? 'text-ok' : 'text-bad'}`}>
                  {createMsg.text}
                </p>
              )}
              <div>
                <button className="btn" onClick={submitCreate} disabled={createBusy}>
                  {createBusy
                    ? provisionMode === 'invite'
                      ? 'Sending…'
                      : 'Creating…'
                    : provisionMode === 'invite'
                      ? 'Send invitation'
                      : 'Create account'}
                </button>
              </div>
            </div>
          )}
          {!showCreate && createMsg?.kind === 'ok' && (
            <p className="text-[0.85rem] text-ok">{createMsg.text}</p>
          )}
        </section>
      ) : (
        <p className="rounded border border-border-strong bg-surface px-3 py-2 text-[0.82rem] text-muted">
          Creating and deleting login accounts requires the{' '}
          <span className="mono">SUPABASE_SERVICE_ROLE_KEY</span> to be set on the server. Role
          management below works without it.
        </p>
      )}

      {/* User table (or empty state) */}
      {users.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong bg-surface p-6 text-muted">
          No users yet.{' '}
          {canManage
            ? 'Create one above to get started.'
            : 'Users appear here once they sign up via Supabase Auth; you can then assign each a clearance level.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th className="ta-r">Override</th>
                {canManage && <th className="ta-r">Account</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = user?.id === u.user_id;
                const busy = busyId === u.user_id;
                return (
                  <tr key={u.user_id}>
                    <td data-label="User">
                      <span className="block">
                        {u.email ?? <span className="mono text-[0.8rem]">{u.user_id}</span>}
                      </span>
                      {isSelf && (
                        <span className="text-[0.72rem] uppercase tracking-[0.06em] text-accent">
                          You
                        </span>
                      )}
                      {rowError?.id === u.user_id && (
                        <span className="mt-1 block text-[0.78rem] text-bad">
                          {rowError.message}
                        </span>
                      )}
                    </td>
                    <td data-label="Role">
                      <select
                        className="input max-w-[12rem]"
                        value={u.role}
                        disabled={busy}
                        onChange={(e) => void changeRole(u, e.target.value as AppRole)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Joined" className="text-text-soft">
                      {fmtDate(u.created_at)}
                    </td>
                    <td data-label="Override" className="ta-r">
                      {u.has_override ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => void removeOverride(u)}
                          title="Remove the explicit role; reverts to the default (viewer)"
                        >
                          {busy ? '…' : 'Remove'}
                        </button>
                      ) : (
                        <span className="text-[0.8rem] text-muted">default</span>
                      )}
                    </td>
                    {canManage && (
                      <td data-label="Account" className="ta-r">
                        <button
                          className="btn btn-sm btn-bad"
                          disabled={busy || isSelf}
                          onClick={() => void removeAccount(u)}
                          title={
                            isSelf
                              ? 'You cannot delete your own account'
                              : 'Permanently delete this login account'
                          }
                        >
                          {busy ? '…' : 'Delete'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

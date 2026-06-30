'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

type Phase = 'checking' | 'ready' | 'no-session' | 'done';

/**
 * Landing page for an email invitation. The invitation link routes through
 * Supabase's verify endpoint, which redirects here with a session (the browser
 * client's detectSessionInUrl establishes it from the URL). Once we have a
 * session, the invitee chooses a password (auth.updateUser) and is sent into the
 * console. If no session materializes, the link is invalid or expired.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [phase, setPhase] = useState<Phase>('checking');
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setPhase('no-session');
      return;
    }
    let active = true;

    const adopt = (sessionEmail: string | null) => {
      if (!active) return;
      setEmail(sessionEmail);
      setPhase('ready');
    };

    // The client may resolve the URL token before or after this effect runs, so we
    // both subscribe and check immediately.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) adopt(session.user.email ?? null);
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session?.user) {
        adopt(data.session.user.email ?? null);
      } else {
        // Give detectSessionInUrl a beat; if still nothing, treat the link as bad.
        setTimeout(() => {
          if (active) setPhase((p) => (p === 'checking' ? 'no-session' : p));
        }, 1500);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  async function setNewPassword() {
    if (!supabase) return;
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords don’t match.');
      return;
    }
    setBusy(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setPhase('done');
    setTimeout(() => {
      router.push('/app');
      router.refresh();
    }, 1200);
  }

  return (
    <main className="grid min-h-[72vh] place-items-center px-5 py-8">
      <div className="card w-full max-w-[380px] p-8">
        <h1 className="text-[1.6rem] font-semibold uppercase tracking-[0.16em]">Atelier</h1>

        {phase === 'checking' && (
          <p className="mb-2 mt-1.5 text-[0.9rem] text-muted">Verifying your invitation…</p>
        )}

        {phase === 'no-session' && (
          <>
            <p className="mb-2 mt-1.5 text-[0.9rem] text-muted">Set up your account</p>
            <p className="mt-3 text-[0.85rem] text-bad">
              This invitation link is invalid or has expired. Ask an administrator to send a new one.
            </p>
            <button className="btn btn-ghost mt-4 w-full" onClick={() => router.push('/login')}>
              Go to sign in
            </button>
          </>
        )}

        {phase === 'ready' && (
          <>
            <p className="mb-6 mt-1.5 text-[0.9rem] text-muted">
              {email ? (
                <>
                  Welcome, <span className="text-text">{email}</span>.{' '}
                </>
              ) : null}
              Choose a password to finish setting up your account.
            </p>
            <label className="mb-[0.9rem] flex flex-col gap-1.5">
              <span className="label">New password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="at least 8 characters"
              />
            </label>
            <label className="mb-[0.9rem] flex flex-col gap-1.5">
              <span className="label">Confirm password</span>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {error && <p className="mt-3 text-[0.85rem] text-bad">{error}</p>}
            <button
              className="btn mt-1 w-full"
              onClick={setNewPassword}
              disabled={busy || !password || !confirm}
            >
              {busy ? 'Saving…' : 'Set password & continue'}
            </button>
          </>
        )}

        {phase === 'done' && (
          <>
            <p className="mb-2 mt-1.5 text-[0.9rem] text-muted">All set</p>
            <p className="mt-3 text-[0.85rem] text-ok">
              Your password has been saved. Taking you to the console…
            </p>
          </>
        )}
      </div>
    </main>
  );
}

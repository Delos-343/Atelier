'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (!supabase) {
      setError('Supabase isn’t configured. Add your project URL and anon key to .env.local — see the README.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    // Honor a safe internal ?next, else land in the app.
    const next = new URLSearchParams(window.location.search).get('next');
    router.push(next && next.startsWith('/') ? next : '/app');
    router.refresh();
  }

  return (
    <main className="grid min-h-[72vh] place-items-center px-5 py-8">
      <div className="card w-full max-w-[380px] p-8">
        <h1 className="text-[1.6rem] font-semibold uppercase tracking-[0.16em]">Atelier</h1>
        <p className="mb-6 mt-1.5 text-[0.9rem] text-muted">Sign in to the manufacturing console.</p>

        {!supabase && (
          <p className="mb-4 text-[0.85rem] text-bad">
            No backend connected. Set <span className="mono">NEXT_PUBLIC_SUPABASE_URL</span> and{' '}
            <span className="mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> in <span className="mono">.env.local</span>.
          </p>
        )}

        <label className="mb-[0.9rem] flex flex-col gap-1.5">
          <span className="label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="mb-[0.9rem] flex flex-col gap-1.5">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <p className="mt-3 text-[0.85rem] text-bad">{error}</p>}

        <button className="btn mt-1 w-full" onClick={signIn} disabled={busy || !email || !password || !supabase}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </main>
  );
}

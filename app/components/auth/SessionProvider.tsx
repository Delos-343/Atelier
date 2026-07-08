'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/supabase/client';

export type AppRole = 'admin' | 'production' | 'qc' | 'viewer';

export interface SessionUser {
  id: string;
  email: string | null;
}

interface SessionValue {
  user: SessionUser | null;
  role: AppRole | null;
  loading: boolean;
  isConfigured: boolean;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within <SessionProvider>');
  return ctx;
}

export function useRole(): AppRole | null {
  return useSession().role;
}

export function SessionProvider({
  initialUser,
  initialRole,
  children,
}: {
  initialUser: SessionUser | null;
  initialRole: AppRole | null;
  children: ReactNode;
}) {
  const clientRef = useRef<ReturnType<typeof createClient> | undefined>(undefined);
  if (clientRef.current === undefined) clientRef.current = createClient();
  const supabase = clientRef.current;
  const isConfigured = supabase !== null;

  const [user, setUser] = useState<SessionUser | null>(initialUser);
  const [role, setRole] = useState<AppRole | null>(initialRole);
  const [loading, setLoading] = useState(false);

  const fetchRole = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc('current_app_role');
    setRole(error ? 'viewer' : ((data as AppRole) ?? 'viewer'));
  }, [supabase]);

  useEffect(() => {
    if (!supabase) return;
    // Fires INITIAL_SESSION on mount, then on every sign-in/out/refresh.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u ? { id: u.id, email: u.email ?? null } : null);
      if (u) void fetchRole();
      else setRole(null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, fetchRole]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setUser(null);
      setRole(null);
      setLoading(false);
      // Full navigation clears any authed server-rendered state.
      window.location.assign('/');
    }
  }, [supabase]);

  return (
    <SessionContext.Provider value={{ user, role, loading, isConfigured, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

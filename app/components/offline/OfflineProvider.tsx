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
import { getStore } from '@/lib/offline/idb-store';
import { enqueue, flush, pending, type KVStore } from '@/lib/offline/outbox';
import { useOnline } from '@/lib/offline/use-online';
import { OfflineBanner } from './OfflineBanner';

export interface SubmitResult {
  queued: boolean; // stored for later because offline / transient failure
  ok: boolean; // succeeded online
  error?: string;
}

interface OfflineContextValue {
  online: boolean;
  pendingCount: number;
  submit: (url: string, body: unknown) => Promise<SubmitResult>;
  sync: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline must be used within <OfflineProvider>');
  return ctx;
}

export function OfflineProvider({ children }: { children: ReactNode }) {
  const online = useOnline();
  const [pendingCount, setPendingCount] = useState(0);
  const storeRef = useRef<KVStore | null>(null);
  if (storeRef.current === null) storeRef.current = getStore();
  const store = storeRef.current;

  const refresh = useCallback(async () => {
    setPendingCount((await pending(store)).length);
  }, [store]);

  const sync = useCallback(async () => {
    await flush(store, fetch);
    await refresh();
  }, [store, refresh]);

  const submit = useCallback(
    async (url: string, body: unknown): Promise<SubmitResult> => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await enqueue(store, url, body);
        await refresh();
        return { queued: true, ok: false };
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) return { queued: false, ok: true };
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status >= 500) {
          await enqueue(store, url, body); // transient — retry on next sync
          await refresh();
          return { queued: true, ok: false, error: payload.error };
        }
        return { queued: false, ok: false, error: payload.error ?? `request failed (${res.status})` };
      } catch {
        await enqueue(store, url, body); // network dropped mid-request
        await refresh();
        return { queued: true, ok: false };
      }
    },
    [store, refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // replay the queue whenever connectivity is (re)gained
  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  return (
    <OfflineContext.Provider value={{ online, pendingCount, submit, sync }}>
      <OfflineBanner online={online} pendingCount={pendingCount} onSync={sync} />
      {children}
    </OfflineContext.Provider>
  );
}

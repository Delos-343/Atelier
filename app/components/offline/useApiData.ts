'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ApiData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  stale: boolean; // served from cache while offline
  reload: () => void;
}

/**
 * Fetches JSON of shape { data: T } from an API route. The service worker caches
 * GET /api responses (stale-while-revalidate), so when offline this resolves with
 * the last synced payload and flags it stale.
 */
export function useApiData<T>(url: string): ApiData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const payload = (await res.json()) as { data?: T; error?: string };
      if (!res.ok) throw new Error(payload.error ?? `request failed (${res.status})`);
      setData((payload.data ?? null) as T | null);
      setStale(typeof navigator !== 'undefined' && !navigator.onLine);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
      setStale(true);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, stale, reload: load };
}

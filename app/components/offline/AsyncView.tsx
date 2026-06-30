'use client';

import type { ReactNode } from 'react';
import type { ApiData } from './useApiData';

const STATE = 'rounded border border-dashed border-border-strong bg-surface p-6 text-muted';

/**
 * Renders the loading / error / empty states for an API-backed view in one place,
 * then hands the loaded rows to `children`. Keeps the offline-aware data UX uniform.
 */
export function AsyncView<T>({
  state,
  empty,
  children,
}: {
  state: ApiData<T[]>;
  empty: string;
  children: (rows: T[]) => ReactNode;
}) {
  const { data, error, loading } = state;
  if (loading && !data) return <p className={STATE}>Loading…</p>;
  if (error && !data) return <p className={STATE}>Could not load — {error}</p>;
  if (!data || data.length === 0) return <p className={STATE}>{empty}</p>;
  return <>{children(data)}</>;
}

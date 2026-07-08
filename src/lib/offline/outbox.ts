// Pure offline-outbox logic. Storage is abstracted behind KVStore so the queue
// behaviour can be unit-tested without a browser (see __tests__/outbox.test.ts).

export interface OutboxItem {
  id: string;
  url: string;
  method: 'POST';
  body: unknown;
  createdAt: number;
  attempts: number;
}

export interface KVStore {
  getAll(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface FlushResult {
  sent: number;
  dropped: number; // permanent client errors (4xx) removed to avoid a poison queue
  kept: number; // still queued (offline or transient 5xx)
}

export function makeId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function enqueue(store: KVStore, url: string, body: unknown): Promise<OutboxItem> {
  const item: OutboxItem = { id: makeId(), url, method: 'POST', body, createdAt: Date.now(), attempts: 0 };
  await store.put(item);
  return item;
}

/** Pending items, oldest first (replay must preserve submission order). */
export async function pending(store: KVStore): Promise<OutboxItem[]> {
  const items = await store.getAll();
  return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Replay queued requests in order.
 *  - 2xx        -> remove (success)
 *  - 4xx        -> remove (won't ever succeed; surfaced earlier at submit time)
 *  - 5xx/throw  -> keep and bump attempts (retry on next flush)
 */
export async function flush(store: KVStore, fetchImpl: typeof fetch): Promise<FlushResult> {
  const items = await pending(store);
  let sent = 0;
  let dropped = 0;
  let kept = 0;

  for (const item of items) {
    try {
      const res = await fetchImpl(item.url, {
        method: item.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      if (res.ok) {
        await store.remove(item.id);
        sent++;
      } else if (res.status >= 400 && res.status < 500) {
        await store.remove(item.id);
        dropped++;
      } else {
        await store.put({ ...item, attempts: item.attempts + 1 });
        kept++;
      }
    } catch {
      await store.put({ ...item, attempts: item.attempts + 1 });
      kept++;
    }
  }

  return { sent, dropped, kept };
}

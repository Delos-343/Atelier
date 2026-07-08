import { describe, it, expect } from 'vitest';
import { enqueue, pending, flush, makeId, type KVStore, type OutboxItem } from '../outbox';

function memoryStore(seed: OutboxItem[] = []): KVStore {
  const map = new Map<string, OutboxItem>(seed.map((i) => [i.id, i]));
  return {
    async getAll() {
      return [...map.values()];
    },
    async put(i) {
      map.set(i.id, i);
    },
    async remove(id) {
      map.delete(id);
    },
  };
}

const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
const offlineFetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;
const status = (code: number) =>
  (async () => new Response(JSON.stringify({ error: 'x' }), { status: code })) as unknown as typeof fetch;

describe('outbox', () => {
  it('enqueues and returns pending oldest-first', async () => {
    const store = memoryStore();
    const a = await enqueue(store, '/api/qc', { n: 1 });
    // force a later timestamp on the second item
    const b: OutboxItem = { id: makeId(), url: '/api/qc', method: 'POST', body: { n: 2 }, createdAt: a.createdAt + 5, attempts: 0 };
    await store.put(b);
    const list = await pending(store);
    expect(list.map((i) => (i.body as { n: number }).n)).toEqual([1, 2]);
  });

  it('flushes successfully and empties the queue', async () => {
    const store = memoryStore();
    await enqueue(store, '/api/production', { code: 'PO-1' });
    await enqueue(store, '/api/production', { code: 'PO-2' });
    const res = await flush(store, okFetch);
    expect(res).toEqual({ sent: 2, dropped: 0, kept: 0 });
    expect((await store.getAll()).length).toBe(0);
  });

  it('retains items and bumps attempts when offline', async () => {
    const store = memoryStore();
    await enqueue(store, '/api/qc', { lotId: 'x', status: 'passed' });
    const res = await flush(store, offlineFetch);
    expect(res.kept).toBe(1);
    expect(res.sent).toBe(0);
    const [item] = await store.getAll();
    expect(item.attempts).toBe(1);
  });

  it('drops 4xx (poison) items but keeps 5xx for retry', async () => {
    const bad = memoryStore();
    await enqueue(bad, '/api/qc', { malformed: true });
    expect(await flush(bad, status(400))).toEqual({ sent: 0, dropped: 1, kept: 0 });
    expect((await bad.getAll()).length).toBe(0);

    const transient = memoryStore();
    await enqueue(transient, '/api/qc', { ok: true });
    expect(await flush(transient, status(503))).toEqual({ sent: 0, dropped: 0, kept: 1 });
    expect((await transient.getAll()).length).toBe(1);
  });
});

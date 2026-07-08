import type { KVStore, OutboxItem } from './outbox';

const DB_NAME = 'atelier-offline';
const STORE = 'outbox';

function memoryStore(): KVStore {
  const map = new Map<string, OutboxItem>();
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbStore(): KVStore {
  return {
    async getAll() {
      const db = await openDb();
      return (await tx<OutboxItem[]>(db, 'readonly', (s) => s.getAll())) ?? [];
    },
    async put(item) {
      const db = await openDb();
      await tx(db, 'readwrite', (s) => s.put(item));
    },
    async remove(id) {
      const db = await openDb();
      await tx(db, 'readwrite', (s) => s.delete(id));
    },
  };
}

let cached: KVStore | null = null;

/** Returns the durable IndexedDB store in the browser, or an in-memory store otherwise. */
export function getStore(): KVStore {
  if (cached) return cached;
  cached = typeof indexedDB !== 'undefined' ? idbStore() : memoryStore();
  return cached;
}

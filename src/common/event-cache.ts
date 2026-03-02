import type { NostrEvent } from '../../types/nostr';
import { isTimelineCacheEnabled } from './cache-settings.js';

const DB_NAME: string = 'nostr_event_cache_v1';
const DB_VERSION: number = 1;
const STORE_NAME: string = 'events';
const MAX_EVENTS: number = 1000;
const TTL_MS: number = 7 * 24 * 60 * 60 * 1000;

interface CachedEventRecord {
  id: string;
  event: NostrEvent;
  storedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB not available'));
      return;
    }
    const request: IDBOpenDBRequest = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (): void => {
      const db: IDBDatabase = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store: IDBObjectStore = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
        });
        store.createIndex('storedAt', 'storedAt');
      }
    };
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(request.error || new Error('Failed to open indexedDB'));
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function pruneStore(db: IDBDatabase): Promise<void> {
  const tx: IDBTransaction = db.transaction(STORE_NAME, 'readwrite');
  const store: IDBObjectStore = tx.objectStore(STORE_NAME);
  const count: number = await requestToPromise<number>(store.count());
  if (count <= MAX_EVENTS) {
    return;
  }

  const index: IDBIndex = store.index('storedAt');
  let remainingToDelete: number = count - MAX_EVENTS;

  await new Promise<void>((resolve, reject) => {
    const cursorRequest: IDBRequest<IDBCursorWithValue | null> =
      index.openCursor();
    cursorRequest.onsuccess = (): void => {
      const cursor: IDBCursorWithValue | null = cursorRequest.result;
      if (!cursor || remainingToDelete <= 0) {
        resolve();
        return;
      }
      cursor.delete();
      remainingToDelete -= 1;
      cursor.continue();
    };
    cursorRequest.onerror = (): void => reject(cursorRequest.error);
  });
}

export async function getEventCacheStats(): Promise<{
  count: number;
  bytes: number;
}> {
  if (typeof indexedDB === 'undefined') {
    return { count: 0, bytes: 0 };
  }
  try {
    const db: IDBDatabase = await openDb();
    const tx: IDBTransaction = db.transaction(STORE_NAME, 'readonly');
    const store: IDBObjectStore = tx.objectStore(STORE_NAME);
    const encoder: TextEncoder | null =
      typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    let count: number = 0;
    let bytes: number = 0;
    await new Promise<void>((resolve, reject) => {
      const cursorRequest: IDBRequest<IDBCursorWithValue | null> =
        store.openCursor();
      cursorRequest.onsuccess = (): void => {
        const cursor: IDBCursorWithValue | null = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record: CachedEventRecord = cursor.value as CachedEventRecord;
        const json: string = JSON.stringify(record.event);
        bytes += encoder ? encoder.encode(json).length : json.length;
        count += 1;
        cursor.continue();
      };
      cursorRequest.onerror = (): void => reject(cursorRequest.error);
    });
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function clearEventCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  try {
    const db: IDBDatabase = await openDb();
    const tx: IDBTransaction = db.transaction(STORE_NAME, 'readwrite');
    const store: IDBObjectStore = tx.objectStore(STORE_NAME);
    store.clear();
  } catch {
    // ignore cache errors
  }
}

export async function getCachedEvent(
  eventId: string,
): Promise<NostrEvent | null> {
  if (typeof indexedDB === 'undefined' || !isTimelineCacheEnabled()) {
    return null;
  }
  try {
    const db: IDBDatabase = await openDb();
    const tx: IDBTransaction = db.transaction(STORE_NAME, 'readwrite');
    const store: IDBObjectStore = tx.objectStore(STORE_NAME);
    const record: CachedEventRecord | undefined = await requestToPromise<
      CachedEventRecord | undefined
    >(store.get(eventId));
    if (!record) {
      return null;
    }
    const now: number = Date.now();
    if (now - record.storedAt > TTL_MS) {
      store.delete(eventId);
      return null;
    }
    return record.event;
  } catch {
    return null;
  }
}

export async function setCachedEvent(event: NostrEvent): Promise<void> {
  if (typeof indexedDB === 'undefined' || !isTimelineCacheEnabled()) {
    return;
  }
  try {
    const db: IDBDatabase = await openDb();
    const tx: IDBTransaction = db.transaction(STORE_NAME, 'readwrite');
    const store: IDBObjectStore = tx.objectStore(STORE_NAME);
    const record: CachedEventRecord = {
      id: event.id,
      event,
      storedAt: Date.now(),
    };
    store.put(record);
    await pruneStore(db);
  } catch {
    // ignore cache errors
  }
}

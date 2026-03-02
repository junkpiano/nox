import type { NostrEvent, PubkeyHex } from '../../../types/nostr.js';
import { isTimelineCacheEnabled } from '../cache-settings.js';
import {
  createTransaction,
  isIndexedDBAvailable,
  requestToPromise,
  transactionToPromise,
} from './indexeddb.js';
import {
  type CachedEvent,
  type EventQueryOptions,
  LIMITS,
  STORE_NAMES,
  TTL,
} from './types.js';

/**
 * Stores a single event in the cache
 */
export async function storeEvent(
  event: NostrEvent,
  options?: { isHomeTimeline?: boolean },
): Promise<void> {
  if (!isIndexedDBAvailable() || !isTimelineCacheEnabled()) return;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);

    const cachedEvent: CachedEvent = {
      id: event.id,
      event,
      pubkey: event.pubkey,
      kind: event.kind,
      created_at: event.created_at,
      storedAt: Date.now(),
      isHomeTimeline: options?.isHomeTimeline,
    };

    store.put(cachedEvent);
    await transactionToPromise(tx);
  } catch (error) {
    console.error('[EventsStore] Failed to store event:', error);
  }
}

/**
 * Stores multiple events in a batch
 */
export async function storeEvents(
  events: NostrEvent[],
  options?: { isHomeTimeline?: boolean },
): Promise<void> {
  if (
    !isIndexedDBAvailable() ||
    !isTimelineCacheEnabled() ||
    events.length === 0
  )
    return;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    const now = Date.now();

    for (const event of events) {
      const cachedEvent: CachedEvent = {
        id: event.id,
        event,
        pubkey: event.pubkey,
        kind: event.kind,
        created_at: event.created_at,
        storedAt: now,
        isHomeTimeline: options?.isHomeTimeline,
      };
      store.put(cachedEvent);
    }

    await transactionToPromise(tx);
    console.log(`[EventsStore] Stored ${events.length} events`);
  } catch (error) {
    console.error('[EventsStore] Failed to store events:', error);
  }
}

/**
 * Retrieves a single event by ID
 */
export async function getEvent(eventId: string): Promise<NostrEvent | null> {
  if (!isIndexedDBAvailable()) return null;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);

    const record = await requestToPromise<CachedEvent | undefined>(
      store.get(eventId),
    );

    if (!record) return null;

    // Check TTL
    const now = Date.now();
    const ttl = record.isHomeTimeline ? TTL.EVENT_HOME : TTL.EVENT_GENERAL;
    if (now - record.storedAt > ttl) {
      // Expired, delete it
      store.delete(eventId);
      return null;
    }

    return record.event;
  } catch (error) {
    console.error('[EventsStore] Failed to get event:', error);
    return null;
  }
}

/**
 * Retrieves multiple events by IDs
 */
export async function getEvents(eventIds: string[]): Promise<NostrEvent[]> {
  if (!isIndexedDBAvailable() || eventIds.length === 0) return [];

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    const now = Date.now();
    const events: NostrEvent[] = [];

    for (const id of eventIds) {
      const record = await requestToPromise<CachedEvent | undefined>(
        store.get(id),
      );

      if (!record) continue;

      // Check TTL
      const ttl = record.isHomeTimeline ? TTL.EVENT_HOME : TTL.EVENT_GENERAL;
      if (now - record.storedAt > ttl) {
        store.delete(id);
        continue;
      }

      events.push(record.event);
    }

    return events;
  } catch (error) {
    console.error('[EventsStore] Failed to get events:', error);
    return [];
  }
}

/**
 * Queries events with filters
 */
export async function queryEvents(
  options: EventQueryOptions = {},
): Promise<NostrEvent[]> {
  if (!isIndexedDBAvailable()) return [];

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    const now = Date.now();
    const events: NostrEvent[] = [];

    // Use appropriate index if available
    let cursorSource: IDBObjectStore | IDBIndex = store;
    let range: IDBKeyRange | undefined;

    if (options.authors && options.authors.length === 1) {
      // Query by specific author
      const index = store.index('pubkey_created_at');
      cursorSource = index;
      range = IDBKeyRange.bound(
        [options.authors[0], options.since ?? 0],
        [options.authors[0], options.until ?? Date.now()],
      );
    } else if (options.since || options.until) {
      // Query by timestamp
      const index = store.index('created_at');
      cursorSource = index;
      range = IDBKeyRange.bound(
        options.since ?? 0,
        options.until ?? Date.now(),
      );
    }

    return new Promise<NostrEvent[]>((resolve, reject) => {
      const cursorRequest = cursorSource.openCursor(range, 'prev'); // Newest first
      let count = 0;
      const limit = options.limit ?? Infinity;
      const offset = options.offset ?? 0;
      let skipped = 0;

      cursorRequest.onsuccess = (): void => {
        const cursor = cursorRequest.result;
        if (!cursor || count >= limit) {
          resolve(events);
          return;
        }

        const record = cursor.value as CachedEvent;

        // Check TTL
        const ttl = record.isHomeTimeline ? TTL.EVENT_HOME : TTL.EVENT_GENERAL;
        if (now - record.storedAt > ttl) {
          cursor.continue();
          return;
        }

        // Apply filters
        if (options.kinds && !options.kinds.includes(record.kind)) {
          cursor.continue();
          return;
        }

        if (
          options.authors &&
          options.authors.length > 1 &&
          !options.authors.includes(record.pubkey as PubkeyHex)
        ) {
          cursor.continue();
          return;
        }

        // Handle offset
        if (skipped < offset) {
          skipped++;
          cursor.continue();
          return;
        }

        events.push(record.event);
        count++;
        cursor.continue();
      };

      cursorRequest.onerror = (): void => reject(cursorRequest.error);
    });
  } catch (error) {
    console.error('[EventsStore] Failed to query events:', error);
    return [];
  }
}

/**
 * Counts total events in the store
 */
export async function countEvents(): Promise<number> {
  if (!isIndexedDBAvailable()) return 0;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    return await requestToPromise<number>(store.count());
  } catch (error) {
    console.error('[EventsStore] Failed to count events:', error);
    return 0;
  }
}

/**
 * Counts protected events (home timeline events)
 */
export async function countProtectedEvents(): Promise<number> {
  if (!isIndexedDBAvailable()) return 0;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readonly');
    const store = tx.objectStore(STORE_NAMES.EVENTS);

    return new Promise<number>((resolve, reject) => {
      let count = 0;
      const request = store.openCursor();

      request.onsuccess = (): void => {
        const cursor = request.result;
        if (cursor) {
          const cachedEvent = cursor.value as CachedEvent;
          if (cachedEvent.isHomeTimeline) {
            count++;
          }
          cursor.continue();
        } else {
          resolve(count);
        }
      };

      request.onerror = (): void => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('[EventsStore] Failed to count protected events:', error);
    return 0;
  }
}

/**
 * Prunes old events when limits are exceeded
 */
export async function pruneEvents(): Promise<number> {
  if (!isIndexedDBAvailable()) return 0;

  try {
    const count = await countEvents();
    if (count <= LIMITS.EVENTS_SOFT) {
      return 0; // No pruning needed
    }

    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    const index = store.index('storedAt');

    const toDelete = count - LIMITS.EVENTS_SOFT;
    let deleted = 0;

    return new Promise<number>((resolve, reject) => {
      const cursorRequest = index.openCursor(); // Oldest first

      cursorRequest.onsuccess = (): void => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= toDelete) {
          console.log(`[EventsStore] Pruned ${deleted} events`);
          resolve(deleted);
          return;
        }

        const record = cursor.value as CachedEvent;

        // Don't delete protected home timeline events
        if (!record.isHomeTimeline) {
          cursor.delete();
          deleted++;
        }

        cursor.continue();
      };

      cursorRequest.onerror = (): void => reject(cursorRequest.error);
    });
  } catch (error) {
    console.error('[EventsStore] Failed to prune events:', error);
    return 0;
  }
}

/**
 * Clears all events from the store
 */
export async function clearEvents(): Promise<void> {
  if (!isIndexedDBAvailable()) return;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);
    await requestToPromise(store.clear());
    console.log('[EventsStore] Cleared all events');
  } catch (error) {
    console.error('[EventsStore] Failed to clear events:', error);
  }
}

/**
 * Deletes specific events by IDs
 */
export async function deleteEvents(eventIds: string[]): Promise<void> {
  if (!isIndexedDBAvailable() || eventIds.length === 0) return;

  try {
    const tx = await createTransaction(STORE_NAMES.EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.EVENTS);

    for (const id of eventIds) {
      store.delete(id);
    }

    await transactionToPromise(tx);
    console.log(`[EventsStore] Deleted ${eventIds.length} events`);
  } catch (error) {
    console.error('[EventsStore] Failed to delete events:', error);
  }
}

/**
 * Gets events by author
 */
export async function getEventsByAuthor(
  pubkey: PubkeyHex,
  options?: { limit?: number; until?: number },
): Promise<NostrEvent[]> {
  return queryEvents({
    authors: [pubkey],
    limit: options?.limit,
    until: options?.until,
  });
}

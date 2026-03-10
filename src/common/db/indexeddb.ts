import {
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  type StoreName,
  type TransactionMode,
} from './types.js';

let dbInstance: IDBDatabase | null = null;

/**
 * Opens or retrieves the cached IndexedDB connection
 */
export async function openDb(): Promise<IDBDatabase> {
  if (dbInstance && dbInstance.version === DB_VERSION) {
    return dbInstance;
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event): void => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      console.log(
        `[IndexedDB] Upgrading from version ${oldVersion} to ${DB_VERSION}`,
      );

      // Create events store
      if (!db.objectStoreNames.contains(STORE_NAMES.EVENTS)) {
        const eventsStore = db.createObjectStore(STORE_NAMES.EVENTS, {
          keyPath: 'id',
        });
        eventsStore.createIndex('pubkey', 'pubkey', { unique: false });
        eventsStore.createIndex('kind', 'kind', { unique: false });
        eventsStore.createIndex('created_at', 'created_at', { unique: false });
        eventsStore.createIndex('storedAt', 'storedAt', { unique: false });
        eventsStore.createIndex('pubkey_created_at', ['pubkey', 'created_at'], {
          unique: false,
        });
        eventsStore.createIndex('isHomeTimeline', 'isHomeTimeline', {
          unique: false,
        });
        console.log('[IndexedDB] Created events store');
      }

      // Create profiles store
      if (!db.objectStoreNames.contains(STORE_NAMES.PROFILES)) {
        const profilesStore = db.createObjectStore(STORE_NAMES.PROFILES, {
          keyPath: 'pubkey',
        });
        profilesStore.createIndex('storedAt', 'storedAt', { unique: false });
        profilesStore.createIndex('accessedAt', 'accessedAt', {
          unique: false,
        });
        console.log('[IndexedDB] Created profiles store');
      }

      // Create timelines store
      if (!db.objectStoreNames.contains(STORE_NAMES.TIMELINES)) {
        const timelinesStore = db.createObjectStore(STORE_NAMES.TIMELINES, {
          keyPath: 'key',
        });
        timelinesStore.createIndex('type', 'type', { unique: false });
        timelinesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        console.log('[IndexedDB] Created timelines store');
      }

      // Create metadata store
      if (!db.objectStoreNames.contains(STORE_NAMES.METADATA)) {
        db.createObjectStore(STORE_NAMES.METADATA, {
          keyPath: 'key',
        });
        console.log('[IndexedDB] Created metadata store');
      }
    };

    request.onsuccess = (): void => {
      dbInstance = request.result;
      console.log('[IndexedDB] Database opened successfully');
      resolve(dbInstance);
    };

    request.onerror = (): void => {
      console.error('[IndexedDB] Failed to open database', request.error);
      reject(request.error || new Error('Failed to open IndexedDB'));
    };

    request.onblocked = (): void => {
      console.warn(
        '[IndexedDB] Database upgrade blocked by another connection',
      );
    };
  });
}

/**
 * Closes the database connection
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    console.log('[IndexedDB] Database closed');
  }
}

/**
 * Creates a transaction for the specified stores
 */
export async function createTransaction(
  storeNames: StoreName | StoreName[],
  mode: TransactionMode = 'readonly',
): Promise<IDBTransaction> {
  const db = await openDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return db.transaction(names, mode);
}

/**
 * Converts an IDBRequest to a Promise
 */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Waits for a transaction to complete
 */
export function transactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void =>
      reject(tx.error || new Error('Transaction failed'));
    tx.onabort = (): void => reject(new Error('Transaction aborted'));
  });
}

/**
 * Deletes the entire database (for testing/debugging)
 */
export async function deleteDatabase(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }

    closeDb();
    const request = indexedDB.deleteDatabase(DB_NAME);

    request.onsuccess = (): void => {
      console.log('[IndexedDB] Database deleted successfully');
      resolve();
    };

    request.onerror = (): void => {
      console.error('[IndexedDB] Failed to delete database', request.error);
      reject(request.error || new Error('Failed to delete database'));
    };

    request.onblocked = (): void => {
      console.warn('[IndexedDB] Database deletion blocked');
    };
  });
}

/**
 * Checks if IndexedDB is available
 */
export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Just enough IndexedDB for the metadata store, in memory.
 *
 * `fake-indexeddb` is not a dependency of this repo, and the metadata store
 * uses only open/upgrade, keyed put/get/getAll/delete/clear and transaction
 * completion. Values are kept by reference, which is enough for a CryptoKey
 * and for anything a test then reads back. Every callback fires on a later
 * turn, as the real thing's do.
 *
 * `failDelete` makes `deleteDatabase` report an error, standing in for a
 * deletion another tab is blocking.
 */

type Row = Record<string, unknown>;

interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: ((event: { oldVersion: number }) => void) | null;
  onblocked?: (() => void) | null;
}

function later(fn: () => void): void {
  setTimeout(fn, 0);
}

function request(result: () => unknown): FakeRequest {
  const req: FakeRequest = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  later((): void => {
    req.result = result();
    req.onsuccess?.();
  });
  return req;
}

class FakeObjectStore {
  readonly rows: Map<unknown, Row> = new Map();
  constructor(readonly keyPath: string) {}
  createIndex(): void {}
}

class FakeDatabase {
  readonly stores: Map<string, FakeObjectStore> = new Map();
  constructor(public version: number) {}

  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name: string): boolean => this.stores.has(name) };
  }

  createObjectStore(
    name: string,
    options: { keyPath: string },
  ): FakeObjectStore {
    const store: FakeObjectStore = new FakeObjectStore(options.keyPath);
    this.stores.set(name, store);
    return store;
  }

  transaction(names: string[]): unknown {
    const tx = {
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      error: null,
      objectStore: (name: string): unknown => {
        const store: FakeObjectStore | undefined = this.stores.get(name);
        if (!store || !names.includes(name))
          throw new Error(`no store ${name}`);
        return {
          put: (row: Row): FakeRequest =>
            request((): unknown => {
              store.rows.set(row[store.keyPath], row);
              return row[store.keyPath];
            }),
          get: (key: unknown): FakeRequest =>
            request((): unknown => store.rows.get(key)),
          getAll: (): FakeRequest =>
            request((): unknown => Array.from(store.rows.values())),
          delete: (key: unknown): FakeRequest =>
            request((): unknown => {
              store.rows.delete(key);
              return undefined;
            }),
          clear: (): FakeRequest =>
            request((): unknown => {
              store.rows.clear();
              return undefined;
            }),
        };
      },
    };
    // Requests are queued before this, so they have all landed when it fires.
    later((): void => later((): void => tx.oncomplete?.()));
    return tx;
  }

  close(): void {}
}

export interface FakeIndexedDb {
  databases: Map<string, FakeDatabase>;
  failDelete: boolean;
  deleted: number;
}

export function installFakeIndexedDb(): FakeIndexedDb {
  const state: FakeIndexedDb = {
    databases: new Map(),
    failDelete: false,
    deleted: 0,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open(name: string, version: number): FakeRequest {
      const req: FakeRequest = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      later((): void => {
        let db: FakeDatabase | undefined = state.databases.get(name);
        const oldVersion: number = db?.version ?? 0;
        if (!db) {
          db = new FakeDatabase(version);
          state.databases.set(name, db);
        }
        req.result = db;
        if (oldVersion < version) {
          db.version = version;
          req.onupgradeneeded?.({ oldVersion });
        }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string): FakeRequest {
      const req: FakeRequest = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      later((): void => {
        if (state.failDelete) {
          req.error = new Error('blocked');
          req.onerror?.();
          return;
        }
        state.databases.delete(name);
        state.deleted += 1;
        req.onsuccess?.();
      });
      return req;
    },
  };
  return state;
}

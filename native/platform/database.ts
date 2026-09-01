/**
 * Binds the SQLite-backed IndexedDB stand-in to the phone.
 *
 * Metro resolves `src/common/db/indexeddb.js` to `sqlite-idb.ts` for this
 * bundle, so the shared stores keep calling exactly what they called before
 * and land here instead. Nothing above this file knows.
 *
 * One thing the module map cannot cover: the stores reach `IDBKeyRange` as a
 * global, not as an import - `IDBKeyRange.bound(...)` in `queryEvents`. A
 * browser provides it; React Native does not. So it is installed on
 * `globalThis` here, which is the only place that knows this is React Native.
 */

import * as SQLite from 'expo-sqlite';

import {
  IdbKeyRange,
  type SqliteLike,
  setSqliteBackend,
} from '../../src/common/db/sqlite-idb';

/** Matches the web cache's name, so the two are recognisably the same thing. */
const DATABASE_NAME = 'nostr_cache_v2.db';

export function installNativeDatabase(): void {
  const db = SQLite.openDatabaseSync(DATABASE_NAME);

  // Write-ahead logging: the timeline reads while the writer batches, and
  // without it the reader waits behind every flush.
  try {
    db.execSync('PRAGMA journal_mode = WAL');
  } catch (error: unknown) {
    console.warn('[database] could not enable WAL', error);
  }

  const backend: SqliteLike = {
    exec: (sql: string): void => {
      db.execSync(sql);
    },
    run: (sql: string, params: unknown[]): void => {
      db.runSync(sql, params as SQLite.SQLiteBindValue[]);
    },
    all: <T>(sql: string, params: unknown[]): T[] =>
      db.getAllSync(sql, params as SQLite.SQLiteBindValue[]) as T[],
  };

  setSqliteBackend(backend);

  // The stores call this as a global, the way a browser supplies it.
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IdbKeyRange;
}

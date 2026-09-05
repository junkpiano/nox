/**
 * The SQLite stand-in for IndexedDB.
 *
 * React Native has no IndexedDB, and the shared stores do not use IndexedDB as
 * a key/value box: they use compound indexes, cursors with a direction, key
 * ranges and counts. This module answers those calls out of SQLite so the
 * stores above it never learn anything changed.
 *
 * These tests are written first and against **real SQLite** - `node:sqlite`
 * here, `expo-sqlite` on the phone - because the risk is not that it fails
 * loudly. It is that key ordering, cursor direction or a range boundary is
 * subtly wrong and the cache quietly returns the wrong events, which looks
 * like data loss rather than like a bug.
 *
 * Every query shape below is copied from a real call site in
 * events-store.ts, profiles-store.ts or timelines-store.ts rather than
 * invented, so passing means the shapes the app actually issues work.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createTransaction,
  type IdbCursor,
  IdbKeyRange,
  isIndexedDBAvailable,
  openDb,
  requestToPromise,
  type SqliteLike,
  setSqliteBackend,
} from '../src/common/db/sqlite-idb.js';

/** Binds `node:sqlite` to the same tiny interface expo-sqlite is bound to. */
function nodeBackend(): SqliteLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (sql: string): void => {
      db.exec(sql);
    },
    run: (sql: string, params: unknown[]): void => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: <T>(sql: string, params: unknown[]): T[] =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

interface StoredEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  storedAt: number;
  content: string;
}

function anEvent(over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: 'e1',
    pubkey: 'a'.repeat(64),
    kind: 1,
    created_at: 1000,
    storedAt: 1,
    content: 'hello',
    ...over,
  };
}

/** A fresh database per test; nothing here should depend on leftovers. */
async function fresh(): Promise<void> {
  setSqliteBackend(nodeBackend());
  await openDb();
}

async function putAll(events: StoredEvent[]): Promise<void> {
  const tx = await createTransaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const event of events) {
    store.put(event);
  }
}

/** Walks a cursor to the end, exactly as every call site does. */
function drain<T>(request: {
  onsuccess: (() => void) | null;
  result: IdbCursor<T> | null;
}): Promise<T[]> {
  return new Promise<T[]>((resolve) => {
    const out: T[] = [];
    request.onsuccess = (): void => {
      const cursor = request.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
  });
}

// --- the basics ----------------------------------------------------------

test('sqlite-idb: reports itself available once a backend is bound', async () => {
  await fresh();
  assert.equal(isIndexedDBAvailable(), true);
});

test('sqlite-idb: put then get returns the record', async () => {
  await fresh();
  await putAll([anEvent({ id: 'x', content: 'kept' })]);

  const tx = await createTransaction('events', 'readonly');
  const got = await requestToPromise<StoredEvent | undefined>(
    tx.objectStore('events').get('x'),
  );

  assert.equal(got?.content, 'kept');
});

test('sqlite-idb: put on an existing key replaces rather than duplicates', async () => {
  await fresh();
  await putAll([anEvent({ id: 'x', content: 'first' })]);
  await putAll([anEvent({ id: 'x', content: 'second' })]);

  const tx = await createTransaction('events', 'readonly');
  const got = await requestToPromise<StoredEvent | undefined>(
    tx.objectStore('events').get('x'),
  );
  const count = await requestToPromise<number>(
    tx.objectStore('events').count(),
  );

  assert.equal(got?.content, 'second');
  assert.equal(count, 1);
});

test('sqlite-idb: getting an absent key gives undefined, as IndexedDB does', async () => {
  await fresh();
  const tx = await createTransaction('events', 'readonly');
  const got = await requestToPromise<StoredEvent | undefined>(
    tx.objectStore('events').get('missing'),
  );
  assert.equal(got, undefined);
});

test('sqlite-idb: delete removes just that record', async () => {
  await fresh();
  await putAll([anEvent({ id: 'a' }), anEvent({ id: 'b' })]);

  const tx = await createTransaction('events', 'readwrite');
  tx.objectStore('events').delete('a');

  const read = await createTransaction('events', 'readonly');
  assert.equal(
    await requestToPromise<StoredEvent | undefined>(
      read.objectStore('events').get('a'),
    ),
    undefined,
  );
  assert.equal(
    await requestToPromise<number>(read.objectStore('events').count()),
    1,
  );
});

// --- cursors -------------------------------------------------------------

test('sqlite-idb: a store cursor visits every record', async () => {
  await fresh();
  await putAll([
    anEvent({ id: 'a' }),
    anEvent({ id: 'b' }),
    anEvent({ id: 'c' }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(tx.objectStore('events').openCursor());

  assert.deepEqual(seen.map((e: StoredEvent): string => e.id).sort(), [
    'a',
    'b',
    'c',
  ]);
});

test('sqlite-idb: an index cursor is oldest first, which pruning depends on', async () => {
  // pruneEvents and pruneProfiles both walk an index forwards and delete as
  // they go. If this came back newest first they would delete the wrong end.
  await fresh();
  await putAll([
    anEvent({ id: 'new', storedAt: 300 }),
    anEvent({ id: 'old', storedAt: 100 }),
    anEvent({ id: 'mid', storedAt: 200 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(
    tx.objectStore('events').index('storedAt').openCursor(),
  );

  assert.deepEqual(
    seen.map((e: StoredEvent): string => e.id),
    ['old', 'mid', 'new'],
  );
});

test("sqlite-idb: direction 'prev' is newest first, which the timeline depends on", async () => {
  await fresh();
  await putAll([
    anEvent({ id: 'old', created_at: 100 }),
    anEvent({ id: 'new', created_at: 300 }),
    anEvent({ id: 'mid', created_at: 200 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(
    tx.objectStore('events').index('created_at').openCursor(undefined, 'prev'),
  );

  assert.deepEqual(
    seen.map((e: StoredEvent): string => e.id),
    ['new', 'mid', 'old'],
  );
});

test('sqlite-idb: a cursor can stop early without draining', async () => {
  // queryEvents stops at `limit` and never calls continue() again.
  await fresh();
  await putAll([
    anEvent({ id: 'a', created_at: 100 }),
    anEvent({ id: 'b', created_at: 200 }),
    anEvent({ id: 'c', created_at: 300 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const request = tx
    .objectStore('events')
    .index('created_at')
    .openCursor<StoredEvent>(undefined, 'prev');

  const first = await new Promise<StoredEvent | null>((resolve) => {
    request.onsuccess = (): void => {
      resolve(request.result ? request.result.value : null);
    };
  });

  assert.equal(first?.id, 'c');
});

// --- key ranges ----------------------------------------------------------

test('sqlite-idb: bound() on a plain index includes both ends', async () => {
  // IndexedDB bounds are inclusive unless told otherwise, and queryEvents
  // relies on that for `since` and `until`.
  await fresh();
  await putAll([
    anEvent({ id: 'below', created_at: 99 }),
    anEvent({ id: 'lower', created_at: 100 }),
    anEvent({ id: 'inside', created_at: 150 }),
    anEvent({ id: 'upper', created_at: 200 }),
    anEvent({ id: 'above', created_at: 201 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(
    tx
      .objectStore('events')
      .index('created_at')
      .openCursor(IdbKeyRange.bound(100, 200)),
  );

  assert.deepEqual(
    seen.map((e: StoredEvent): string => e.id),
    ['lower', 'inside', 'upper'],
  );
});

test('sqlite-idb: bound() on the compound index filters by author and time', async () => {
  // Copied from queryEvents: the single-author path uses
  // IDBKeyRange.bound([author, since], [author, until]) over
  // ['pubkey', 'created_at']. Getting this wrong returns another author's
  // posts, which is the worst failure this shim could have.
  await fresh();
  const alice = 'a'.repeat(64);
  const bob = 'b'.repeat(64);
  await putAll([
    anEvent({ id: 'alice-early', pubkey: alice, created_at: 50 }),
    anEvent({ id: 'alice-in', pubkey: alice, created_at: 150 }),
    anEvent({ id: 'alice-late', pubkey: alice, created_at: 900 }),
    anEvent({ id: 'bob-in', pubkey: bob, created_at: 150 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(
    tx
      .objectStore('events')
      .index('pubkey_created_at')
      .openCursor(IdbKeyRange.bound([alice, 100], [alice, 200]), 'prev'),
  );

  assert.deepEqual(
    seen.map((e: StoredEvent): string => e.id),
    ['alice-in'],
  );
});

test('sqlite-idb: the compound index orders by the second key within an author', async () => {
  await fresh();
  const alice = 'a'.repeat(64);
  await putAll([
    anEvent({ id: 'first', pubkey: alice, created_at: 100 }),
    anEvent({ id: 'third', pubkey: alice, created_at: 300 }),
    anEvent({ id: 'second', pubkey: alice, created_at: 200 }),
  ]);

  const tx = await createTransaction('events', 'readonly');
  const seen = await drain<StoredEvent>(
    tx
      .objectStore('events')
      .index('pubkey_created_at')
      .openCursor(IdbKeyRange.bound([alice, 0], [alice, 9999]), 'prev'),
  );

  assert.deepEqual(
    seen.map((e: StoredEvent): string => e.id),
    ['third', 'second', 'first'],
  );
});

// --- the other stores ----------------------------------------------------

test('sqlite-idb: profiles are keyed by pubkey, not by id', async () => {
  await fresh();
  const tx = await createTransaction('profiles', 'readwrite');
  tx.objectStore('profiles').put({
    pubkey: 'p1',
    name: 'someone',
    storedAt: 1,
    accessedAt: 2,
  });

  const read = await createTransaction('profiles', 'readonly');
  const got = await requestToPromise<{ name: string } | undefined>(
    read.objectStore('profiles').get('p1'),
  );

  assert.equal(got?.name, 'someone');
});

test('sqlite-idb: timelines are keyed by key, and countable', async () => {
  await fresh();
  const tx = await createTransaction('timelines', 'readwrite');
  tx.objectStore('timelines').put({ key: 'home', type: 'home', updatedAt: 5 });
  tx.objectStore('timelines').put({
    key: 'global',
    type: 'global',
    updatedAt: 6,
  });

  const read = await createTransaction('timelines', 'readonly');
  assert.equal(
    await requestToPromise<number>(read.objectStore('timelines').count()),
    2,
  );
});

test('sqlite-idb: a record survives being written and read in separate transactions', async () => {
  // The stores open a transaction per call; nothing may live only in one.
  await fresh();
  await putAll([anEvent({ id: 'persisted', content: 'still here' })]);

  const tx = await createTransaction('events', 'readonly');
  const got = await requestToPromise<StoredEvent | undefined>(
    tx.objectStore('events').get('persisted'),
  );

  assert.equal(got?.content, 'still here');
});

test('sqlite-idb: values come back as values, not as JSON text', async () => {
  // Everything is stored as JSON, and a caller that received a string instead
  // of an object would fail far away from here.
  await fresh();
  await putAll([anEvent({ id: 'shaped', kind: 7, created_at: 42 })]);

  const tx = await createTransaction('events', 'readonly');
  const got = await requestToPromise<StoredEvent | undefined>(
    tx.objectStore('events').get('shaped'),
  );

  assert.equal(typeof got, 'object');
  assert.equal(got?.kind, 7);
  assert.equal(got?.created_at, 42);
});

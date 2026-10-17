/**
 * Removing the plaintext message cache an older build left behind.
 *
 * The value is replaced with ciphertext first, then the whole database is
 * deleted and its metadata written back, because deleting the database is
 * the only way to take the old bytes off disk. A deletion that is blocked
 * leaves a flag so the next launch finishes the job.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PubkeyHex } from '../types/nostr';
import { installFakeIndexedDb } from './fakes/fake-indexeddb.js';
import { installFakeStorage } from './fakes/fake-storage.js';

const idb = installFakeIndexedDb();
installFakeStorage();
const quietLog = console.log;
const quietWarn = console.warn;
console.log = (): void => {};
console.warn = (): void => {};

const { getAllMetadata, getMetadata, setMetadata } = await import(
  '../src/common/db/index.js'
);
const { isEncryptedPayload } = await import(
  '../src/features/messages/message-crypto.js'
);
const { getConversation } = await import(
  '../src/features/messages/messages-store.js'
);
const { migrateLegacyMessageCache } = await import(
  '../src/features/messages/plaintext-cache-migration.js'
);

const CACHE_KEY: string = 'dm_messages_v1';
const PENDING_KEY: string = 'dm_cache_rebuild_pending';
const PEER: PubkeyHex = 'b'.repeat(64) as PubkeyHex;

test.after((): void => {
  console.log = quietLog;
  console.warn = quietWarn;
});

test('nothing to migrate means the database is left alone', async () => {
  await setMetadata('mute_list', ['x']);
  await migrateLegacyMessageCache();
  assert.equal(idb.deleted, 0);
  assert.deepEqual(await getMetadata('mute_list'), ['x']);
});

test('an encrypted cache with no pending rebuild is left alone', async () => {
  await setMetadata(CACHE_KEY, { v: 2, ct: 'already encrypted' });
  await migrateLegacyMessageCache();
  assert.equal(idb.deleted, 0);
});

test('a plaintext cache is encrypted, the database rebuilt, and other metadata carried across', async () => {
  await setMetadata(CACHE_KEY, [
    {
      id: 'm1',
      peer: PEER,
      author: PEER,
      content: 'plaintext secret',
      createdAt: 1,
    },
  ]);
  await migrateLegacyMessageCache();

  assert.equal(idb.deleted, 1);
  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored));
  assert.ok(!JSON.stringify(stored).includes('plaintext secret'));
  assert.deepEqual(await getMetadata('mute_list'), ['x']);
  assert.equal(await getMetadata(PENDING_KEY), null);
  assert.equal(
    (await getAllMetadata()).some(
      (entry): boolean => entry.key === PENDING_KEY,
    ),
    false,
  );
  // The history itself survived.
  assert.equal(getConversation(PEER)[0]?.content, 'plaintext secret');
});

test('a blocked rebuild leaves the value encrypted and a flag for next launch', async () => {
  await setMetadata(CACHE_KEY, [
    { id: 'm2', peer: PEER, author: PEER, content: 'again', createdAt: 2 },
  ]);
  idb.failDelete = true;
  await migrateLegacyMessageCache();

  assert.ok(isEncryptedPayload(await getMetadata(CACHE_KEY)));
  assert.equal(await getMetadata(PENDING_KEY), true);
  assert.equal(idb.deleted, 1);
});

test('the next launch finishes a rebuild the previous one could not', async () => {
  idb.failDelete = false;
  await migrateLegacyMessageCache();

  assert.equal(idb.deleted, 2);
  assert.equal(await getMetadata(PENDING_KEY), null);
  assert.ok(isEncryptedPayload(await getMetadata(CACHE_KEY)));
  assert.deepEqual(await getMetadata('mute_list'), ['x']);

  // And after that there is nothing left to do.
  await migrateLegacyMessageCache();
  assert.equal(idb.deleted, 2);
});

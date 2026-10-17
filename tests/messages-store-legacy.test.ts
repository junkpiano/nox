/**
 * A message cache written before encryption existed is read on start and
 * immediately rewritten as ciphertext.
 *
 * Its own file because the store loads once per process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PubkeyHex } from '../types/nostr';
import { installFakeIndexedDb } from './fakes/fake-indexeddb.js';
import { installFakeStorage } from './fakes/fake-storage.js';

installFakeIndexedDb();
installFakeStorage();
const quietLog = console.log;
console.log = (): void => {};

const { getMetadata, setMetadata } = await import('../src/common/db/index.js');
const { isEncryptedPayload } = await import(
  '../src/features/messages/message-crypto.js'
);
const store = await import('../src/features/messages/messages-store.js');

const CACHE_KEY: string = 'dm_messages_v1';
const CAROL: PubkeyHex = 'c'.repeat(64) as PubkeyHex;

test.after((): void => {
  console.log = quietLog;
});

test('a plaintext cache is loaded, then replaced on disk with ciphertext', async () => {
  await setMetadata(CACHE_KEY, [
    {
      id: 'l1',
      peer: CAROL,
      author: CAROL,
      content: 'old words',
      createdAt: 5,
    },
  ]);
  await store.loadCachedMessages();
  await store.flushMessageCache();

  assert.equal(store.getConversation(CAROL)[0]?.content, 'old words');
  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored));
  assert.ok(!JSON.stringify(stored).includes('old words'));
});

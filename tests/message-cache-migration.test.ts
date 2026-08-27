/**
 * The upgrade path for the message cache.
 *
 * Encrypting the cache means every existing install has a plaintext blob that
 * has to be read once and then replaced. Getting this wrong either loses
 * someone's message history or leaves the plaintext on disk, so it is worth
 * testing against real IndexedDB semantics rather than a stub.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PubkeyHex } from '../types/nostr';

// The store dispatches an event whenever messages change.
(globalThis as { window?: unknown }).window = {
  dispatchEvent: (): boolean => true,
};

const { getMetadata, setMetadata } = await import('../src/common/db/index.js');
const { isEncryptedPayload } = await import(
  '../src/features/messages/message-crypto.js'
);
const { loadCachedMessages, getConversation, clearMessages } = await import(
  '../src/features/messages/messages-store.js'
);

const CACHE_KEY: string = 'dm_messages_v1';
const VIEWER: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
const PEER: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
const SECRET: string = 'meet me at the usual place';

/** Writes are fire-and-forget; let the queued one land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a plaintext cache is read once, then replaced with ciphertext', async () => {
  await setMetadata(CACHE_KEY, [
    {
      id: 'msg-1',
      peer: PEER,
      author: PEER,
      content: SECRET,
      createdAt: 1_700_000_000,
    },
  ]);

  await loadCachedMessages();
  await settle();

  // The history survived the upgrade.
  const thread = getConversation(PEER);
  assert.equal(thread.length, 1);
  assert.equal(thread[0]?.content, SECRET);

  // And the plaintext copy is gone.
  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(!Array.isArray(stored), 'expected the array to be replaced');
  assert.ok(isEncryptedPayload(stored), 'expected an encrypted payload');
  assert.ok(
    !JSON.stringify(stored).includes(SECRET),
    'plaintext must not remain on disk',
  );
});

test('the key outlives the page, so a reload can still decrypt', async () => {
  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored));

  // A fresh module instance has no key in memory and must recover it from
  // storage - which is exactly what happens after a reload. If the key did not
  // persist, every session would silently start with an unreadable cache.
  const reloadPath: string =
    '../src/features/messages/message-crypto.js?reload=1';
  const reloaded = (await import(
    reloadPath
  )) as typeof import('../src/features/messages/message-crypto.js');

  const restored = await reloaded.decryptJson<{ content: string }[]>(stored);
  assert.ok(restored, 'a reload must be able to read the cache');
  assert.equal(restored[0]?.content, SECRET);
});

test('clearing on logout leaves nothing readable behind', async () => {
  clearMessages();
  await settle();

  assert.equal(getConversation(PEER).length, 0);
  assert.equal(await getMetadata(CACHE_KEY), null);
  assert.equal(VIEWER.length, 64);
});

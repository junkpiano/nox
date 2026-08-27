/**
 * The database rebuild that removes the plaintext cache.
 *
 * Replacing the value is not enough - LevelDB keeps the old record until it
 * compacts - so the migration deletes the database and puts back what is worth
 * keeping. What has to hold: no message history is lost, other metadata such as
 * the mute list survives, and nothing plaintext is written back.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PubkeyHex } from '../types/nostr';

(globalThis as { window?: unknown }).window = {
  dispatchEvent: (): boolean => true,
};

const { getMetadata, setMetadata } = await import('../src/common/db/index.js');
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
const MUTE_KEY: string = 'mute_list_cache';
const PEER: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
const SECRET: string = 'meet me at the usual place';

test('the rebuild keeps history, keeps metadata, and leaves no plaintext', async () => {
  await setMetadata(CACHE_KEY, [
    {
      id: 'msg-1',
      peer: PEER,
      author: PEER,
      content: SECRET,
      createdAt: 1_700_000_000,
    },
    {
      id: 'msg-2',
      peer: PEER,
      author: PEER,
      content: 'second',
      createdAt: 1_700_000_100,
    },
  ]);
  await setMetadata(MUTE_KEY, { pubkeys: ['c'.repeat(64)] });

  await migrateLegacyMessageCache();

  // History survived.
  const thread = getConversation(PEER);
  assert.equal(thread.length, 2);
  assert.equal(thread[0]?.content, SECRET);
  assert.equal(thread[1]?.content, 'second');

  // Written back encrypted, into the rebuilt database.
  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored), 'expected an encrypted payload');
  assert.ok(!JSON.stringify(stored).includes(SECRET));

  // Metadata worth keeping came across, so the mute list still filters the
  // first render after the upgrade.
  const mute = await getMetadata<{ pubkeys: string[] }>(MUTE_KEY);
  assert.deepEqual(mute, { pubkeys: ['c'.repeat(64)] });
});

test('a second run is a no-op, not a second rebuild', async () => {
  const before: unknown = await getMetadata(CACHE_KEY);
  await migrateLegacyMessageCache();
  const after: unknown = await getMetadata(CACHE_KEY);

  assert.ok(isEncryptedPayload(after));
  assert.deepEqual(after, before, 'an encrypted cache must be left alone');
});

test('a rebuild that could not finish is retried on the next launch', async () => {
  // What a blocked deletion leaves behind: the value is already encrypted, so
  // nothing about the cache itself says there is still cleaning up to do.
  await setMetadata('dm_cache_rebuild_pending', true);
  await setMetadata('carried-through', { kept: true });

  await migrateLegacyMessageCache();

  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored), 'the cache must survive the retry');
  assert.deepEqual(await getMetadata('carried-through'), { kept: true });
  assert.equal(
    await getMetadata('dm_cache_rebuild_pending'),
    null,
    'the flag must be cleared once the rebuild succeeds',
  );

  // And the messages are still readable afterwards.
  const thread = getConversation(PEER);
  assert.equal(thread.length, 2);
});

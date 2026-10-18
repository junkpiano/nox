/**
 * The decrypted message cache: who each message is with, how threads and the
 * conversation list are ordered, the optimistic copy of a sent message, and
 * what reaches disk.
 *
 * IndexedDB is the in-memory stand-in from `fakes/`, so the encrypted blob
 * is really written and really read back by a second copy of the module.
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

const { onAppEvent } = await import('../src/common/app-events.js');
const { getMetadata, setMetadata } = await import('../src/common/db/index.js');
const { decryptJson, encryptJson, isEncryptedPayload } = await import(
  '../src/features/messages/message-crypto.js'
);
const store = await import('../src/features/messages/messages-store.js');
type ChatRumor = import('../src/features/messages/nip17.js').ChatRumor;
type StoredMessage =
  import('../src/features/messages/messages-store.js').StoredMessage;

const CACHE_KEY: string = 'dm_messages_v1';
const ME: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
const BOB: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
const CAROL: PubkeyHex = 'c'.repeat(64) as PubkeyHex;

function rumor(
  id: string,
  author: PubkeyHex,
  content: string,
  createdAt: number,
  to?: PubkeyHex,
): ChatRumor {
  return {
    id,
    pubkey: author,
    created_at: createdAt,
    kind: 14,
    tags: to ? [['p', to]] : [],
    content,
  };
}

test.after((): void => {
  console.log = quietLog;
});

test('on start, the encrypted cache on disk is decrypted into memory, once', async () => {
  const cached: StoredMessage[] = [
    { id: 'd1', peer: BOB, author: BOB, content: 'from disk', createdAt: 7 },
  ];
  await setMetadata(CACHE_KEY, await encryptJson(cached));
  await store.loadCachedMessages();
  assert.deepEqual(store.getConversation(BOB), cached);

  // Loaded already: a second call does not read the disk again.
  await setMetadata(CACHE_KEY, null);
  await store.loadCachedMessages();
  assert.deepEqual(store.getConversation(BOB), cached);
});

test('a received message is filed under its author, a sent one under its p tag', () => {
  store.clearMessages();
  let announced: number = 0;
  const stop = onAppEvent('dm-messages-updated', (): void => {
    announced += 1;
  });

  assert.equal(
    store.addMessages(
      [rumor('m1', BOB, 'hi', 100, ME), rumor('m2', ME, 'hello', 110, BOB)],
      ME,
    ),
    true,
  );
  assert.deepEqual(
    store
      .getConversation(BOB)
      .map((m: StoredMessage): [string, string] => [m.id, m.author]),
    [
      ['m1', BOB],
      ['m2', ME],
    ],
  );
  assert.equal(announced, 1);
  stop();
});

test('a known message, and a sent one naming nobody, change nothing', () => {
  assert.equal(store.addMessages([rumor('m1', BOB, 'hi', 100, ME)], ME), false);
  assert.equal(
    store.addMessages([rumor('m3', ME, 'to whom?', 120)], ME),
    false,
  );
  assert.equal(store.getConversation(BOB).length, 2);
});

test('conversations are listed by latest activity, threads read oldest first', () => {
  store.addMessages(
    [rumor('c1', CAROL, 'early', 50, ME), rumor('c2', CAROL, 'late', 500, ME)],
    ME,
  );
  const list = store.getConversations();
  assert.deepEqual(
    list.map((c): [PubkeyHex, string, number] => [
      c.peer,
      c.lastMessage.id,
      c.messageCount,
    ]),
    [
      [CAROL, 'c2', 2],
      [BOB, 'm2', 2],
    ],
  );
  assert.deepEqual(
    store.getConversation(CAROL).map((m: StoredMessage): string => m.id),
    ['c1', 'c2'],
  );
});

test("a sent message's optimistic copy is replaced when the relay echoes it back", () => {
  store.clearMessages();
  store.addMessages([rumor('local-1', ME, 'on my way', 1000, BOB)], ME);
  // The echo carries a jittered timestamp, up to two days off.
  store.addMessages(
    [rumor('real-1', ME, 'on my way', 1000 - 100_000, BOB)],
    ME,
  );
  assert.deepEqual(
    store.getConversation(BOB).map((m: StoredMessage): string => m.id),
    ['real-1'],
  );
});

test('an optimistic copy arriving after its real one is not added', () => {
  assert.equal(
    store.addMessages([rumor('local-2', ME, 'on my way', 1000, BOB)], ME),
    false,
  );
  assert.equal(store.getConversation(BOB).length, 1);
});

test('the same words outside the echo window are a different message', () => {
  store.addMessages([rumor('local-3', ME, 'again', 1000, BOB)], ME);
  store.addMessages([rumor('real-3', ME, 'again', 1000 + 172_801, BOB)], ME);
  assert.deepEqual(
    store
      .getConversation(BOB)
      .map((m: StoredMessage): string => m.id)
      .sort(),
    ['local-3', 'real-1', 'real-3'],
  );
});

test('what reaches disk is ciphertext', async () => {
  store.clearMessages();
  store.addMessages([rumor('s1', BOB, 'a secret', 100, ME)], ME);
  await store.flushMessageCache();

  const stored: unknown = await getMetadata(CACHE_KEY);
  assert.ok(isEncryptedPayload(stored));
  assert.ok(!JSON.stringify(stored).includes('a secret'));
  assert.deepEqual(
    await decryptJson<StoredMessage[]>(stored),
    store.getConversation(BOB),
  );
});

test('adopted messages replace what is in memory and are written encrypted', async () => {
  store.adoptMessages([
    { id: 'a1', peer: BOB, author: BOB, content: 'adopted', createdAt: 9 },
  ]);
  await store.flushMessageCache();
  assert.deepEqual(
    store.getConversations().map((c): string => c.lastMessage.content),
    ['adopted'],
  );
  assert.ok(isEncryptedPayload(await getMetadata(CACHE_KEY)));
});

test('the cache keeps only the newest two thousand messages', () => {
  store.clearMessages();
  const many: ChatRumor[] = [];
  for (let i = 0; i < 2005; i += 1) {
    many.push(rumor(`n${i}`, BOB, `#${i}`, i, ME));
  }
  store.addMessages(many, ME);
  const thread: StoredMessage[] = store.getConversation(BOB);
  assert.equal(thread.length, 2000);
  assert.equal(thread[0]?.id, 'n5');
});

test('clearing forgets every message, in memory and on disk', async () => {
  store.addMessages([rumor('x1', BOB, 'bye', 1, ME)], ME);
  store.clearMessages();
  assert.deepEqual(store.getConversations(), []);
  await store.flushMessageCache();
  assert.equal(await getMetadata(CACHE_KEY), null);
  assert.equal(await getMetadata('dm_cache_key_v1'), null);
});

/**
 * Fetching an event somebody pointed at: hints first, one request shared by
 * everyone asking at once, and a miss remembered for a minute.
 *
 * There is no IndexedDB under Node, so the event cache always misses here
 * and every answer comes from the in-memory relays.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey } from 'nostr-tools';
import { setTimelineCacheEnabled } from '../src/common/cache-settings.js';
import { LIMITS } from '../src/common/db/index.js';
import {
  clearEventCache,
  EVENT_CACHE_LIMIT,
  getCachedEvent,
  getEventCacheStats,
  setCachedEvent,
} from '../src/common/event-cache.js';
import {
  fetchReferencedEvent,
  rememberReferencedMiss,
} from '../src/common/referenced-event.js';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

memoryKv();
const key: Uint8Array = generateSecretKey();

test('without IndexedDB the event cache is empty and writes go nowhere', async () => {
  const note = signed(key, { kind: 1, content: 'cached?' });
  assert.equal(EVENT_CACHE_LIMIT, LIMITS.EVENTS_HARD);
  await setCachedEvent(note);
  assert.equal(await getCachedEvent(note.id), null);
  assert.deepEqual(await getEventCacheStats(), { count: 0, bytes: 0 });
  await clearEventCache();
  setTimelineCacheEnabled(false);
  await setCachedEvent(note);
  assert.equal(await getCachedEvent(note.id), null);
  setTimelineCacheEnabled(true);
});

test('an event only a hint relay holds is found there', async () => {
  const note = signed(key, { kind: 1, content: 'quoted' });
  fakeRelay('wss://configured.ref');
  const hint = fakeRelay('wss://hint.ref', { events: [note] });
  const found = await fetchReferencedEvent(note.id, ['wss://configured.ref'], {
    hintRelays: ['wss://hint.ref', 'wss://configured.ref'],
  });
  assert.equal(found?.id, note.id);
  assert.equal(hint.requests.length, 1);
});

test('two cards asking at once share one request', async () => {
  const note = signed(key, { kind: 1, content: 'shared' });
  const relay = fakeRelay('wss://shared.ref', { events: [note] });
  const [a, b] = await Promise.all([
    fetchReferencedEvent(note.id, ['wss://shared.ref']),
    fetchReferencedEvent(note.id, ['wss://shared.ref']),
  ]);
  assert.equal(a?.id, note.id);
  assert.equal(b?.id, note.id);
  assert.equal(relay.requests.length, 1);
});

test('a miss is remembered, and asked again only when told to', async () => {
  const relay = fakeRelay('wss://miss.ref');
  const id: string = 'c'.repeat(64);
  assert.equal(await fetchReferencedEvent(id, ['wss://miss.ref']), null);
  assert.equal(relay.requests.length, 1);
  assert.equal(await fetchReferencedEvent(id, ['wss://miss.ref']), null);
  assert.equal(relay.requests.length, 1, 'the miss was remembered');
  assert.equal(
    await fetchReferencedEvent(id, ['wss://miss.ref'], {
      bypassNullCache: true,
    }),
    null,
  );
  assert.equal(relay.requests.length, 2);
});

test('a miss reported by a caller stops the next asker', async () => {
  const relay = fakeRelay('wss://told.ref');
  const id: string = 'd'.repeat(64);
  rememberReferencedMiss(id);
  assert.equal(await fetchReferencedEvent(id, ['wss://told.ref']), null);
  assert.equal(relay.requests.length, 0);
});

test('a forced refresh starts a new request instead of joining one', async () => {
  const note = signed(key, { kind: 1, content: 'again' });
  const relay = fakeRelay('wss://force.ref', { events: [note] });
  const first = fetchReferencedEvent(note.id, ['wss://force.ref']);
  const second = fetchReferencedEvent(note.id, ['wss://force.ref'], {
    forceRefresh: true,
  });
  assert.equal((await first)?.id, note.id);
  assert.equal((await second)?.id, note.id);
  assert.equal(relay.requests.length, 2);
});

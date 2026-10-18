/**
 * People's profiles: memory first, then the store, then the relays - with
 * lookups for the same person shared, a thirty-second pause after a miss,
 * and many people asked about in one query.
 *
 * Node has no IndexedDB, so the profile store reads empty and writes
 * nowhere; everything here is the memory cache and the in-memory relays.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  cacheResolvedProfile,
  fetchProfile,
  fetchProfiles,
  getAuthoritativeProfile,
} from '../src/common/profile-fetch.js';
import type { PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

memoryKv();

function person(): { key: Uint8Array; pubkey: PubkeyHex } {
  const key: Uint8Array = generateSecretKey();
  return { key, pubkey: getPublicKey(key) as PubkeyHex };
}

function profileEvent(
  key: Uint8Array,
  content: string,
  created_at: number = 1_700_000_000,
  tags: string[][] = [],
) {
  return signed(key, { kind: 0, content, created_at, tags });
}

test('no relays and nothing cached is no profile', async () => {
  const { pubkey } = person();
  assert.equal(await fetchProfile(pubkey, []), null);
});

test('a profile from a relay keeps its emoji tags and is then served from memory', async () => {
  const { key, pubkey } = person();
  const relay = fakeRelay('wss://one.profile', {
    events: [
      profileEvent(key, JSON.stringify({ name: 'alice' }), 1_700_000_000, [
        ['emoji', 'wave', 'https://example.com/wave.png'],
        ['t', 'ignored'],
      ]),
    ],
  });
  const profile = await fetchProfile(pubkey, ['wss://one.profile']);
  assert.equal(profile?.name, 'alice');
  assert.deepEqual(profile?.emojiTags, [
    ['emoji', 'wave', 'https://example.com/wave.png'],
  ]);
  const again = await fetchProfile(pubkey, ['wss://one.profile']);
  assert.equal(again?.name, 'alice');
  assert.equal(relay.requests.length, 1, 'the second answer came from memory');
});

test('the remembered profile outranks one just fetched', async () => {
  const { pubkey } = person();
  const remote = { name: 'remote' };
  assert.equal(getAuthoritativeProfile(pubkey, remote), remote);
  assert.equal(getAuthoritativeProfile(pubkey, null), null);
  await cacheResolvedProfile(pubkey, { name: 'remembered' });
  assert.equal(getAuthoritativeProfile(pubkey, remote)?.name, 'remembered');
  assert.equal((await fetchProfile(pubkey, []))?.name, 'remembered');
});

test('two lookups for one person at once share one request', async () => {
  const { key, pubkey } = person();
  const relay = fakeRelay('wss://shared.profile', {
    events: [profileEvent(key, JSON.stringify({ name: 'bob' }))],
  });
  const [a, b] = await Promise.all([
    fetchProfile(pubkey, ['wss://shared.profile']),
    fetchProfile(pubkey, ['wss://shared.profile']),
  ]);
  assert.equal(a?.name, 'bob');
  assert.equal(b?.name, 'bob');
  assert.equal(relay.requests.length, 1);
});

test('after a miss the relays are not asked again for thirty seconds unless forced', async () => {
  const { pubkey } = person();
  const relay = fakeRelay('wss://empty.profile');
  assert.equal(await fetchProfile(pubkey, ['wss://empty.profile']), null);
  assert.equal(relay.requests.length, 1);
  assert.equal(await fetchProfile(pubkey, ['wss://empty.profile']), null);
  assert.equal(relay.requests.length, 1, 'throttled');
  assert.equal(
    await fetchProfile(pubkey, ['wss://empty.profile'], {
      forceRefresh: true,
      usePersistentCache: false,
    }),
    null,
  );
  assert.equal(relay.requests.length, 2);
});

test('an unreadable profile on one relay and a refusing relay still find the readable one', async () => {
  const one = person();
  fakeRelay('wss://garbled.profile', {
    events: [profileEvent(one.key, '{not json')],
  });
  fakeRelay('wss://refusing.profile', { refuses: true });
  assert.equal(
    await fetchProfile(one.pubkey, [
      'wss://garbled.profile',
      'wss://refusing.profile',
    ]),
    null,
  );

  const two = person();
  fakeRelay('wss://good.profile', {
    events: [profileEvent(two.key, JSON.stringify({ name: 'carol' }))],
  });
  const found = await fetchProfile(two.pubkey, [
    'wss://garbled.profile',
    'wss://refusing.profile',
    'wss://good.profile',
  ]);
  assert.equal(found?.name, 'carol');
});

test('several people are asked about in one query, and the cache answers next time', async () => {
  const a = person();
  const b = person();
  const c = person();
  const relay = fakeRelay('wss://batch.profile', {
    events: [
      profileEvent(a.key, JSON.stringify({ name: 'a' })),
      profileEvent(b.key, JSON.stringify({ name: 'b' })),
    ],
  });
  const found = await fetchProfiles(
    [a.pubkey, b.pubkey, c.pubkey, a.pubkey],
    ['wss://batch.profile'],
  );
  assert.equal(relay.requests.length, 1);
  assert.deepEqual(relay.requests[0]?.authors, [a.pubkey, b.pubkey, c.pubkey]);
  assert.equal(found.get(a.pubkey)?.name, 'a');
  assert.equal(found.get(b.pubkey)?.name, 'b');
  assert.equal(found.has(c.pubkey), false);

  const again = await fetchProfiles(
    [a.pubkey, b.pubkey, c.pubkey],
    ['wss://batch.profile'],
  );
  assert.equal(again.get(a.pubkey)?.name, 'a');
  assert.equal(relay.requests.length, 1, 'c was missed moments ago');
});

test('an unreadable newest profile gives way to an older readable one', async () => {
  const { key, pubkey } = person();
  fakeRelay('wss://edits.profile', {
    events: [
      profileEvent(key, JSON.stringify({ name: 'old' }), 100, [
        ['emoji', 'x', 'https://example.com/x.png'],
      ]),
      profileEvent(key, '[1,2,3]', 200),
      profileEvent(key, 'garbage', 300),
    ],
  });
  const found = await fetchProfiles([pubkey], ['wss://edits.profile']);
  assert.equal(found.get(pubkey)?.name, 'old');
  assert.deepEqual(found.get(pubkey)?.emojiTags, [
    ['emoji', 'x', 'https://example.com/x.png'],
  ]);
});

test('cached-only and relay-less lookups never ask a relay', async () => {
  const { key, pubkey } = person();
  const relay = fakeRelay('wss://quiet.profile', {
    events: [profileEvent(key, JSON.stringify({ name: 'q' }))],
  });
  const cached = await fetchProfiles([pubkey], ['wss://quiet.profile'], {
    cachedOnly: true,
  });
  assert.equal(cached.size, 0);
  assert.equal((await fetchProfiles([pubkey], [])).size, 0);
  assert.equal(relay.requests.length, 0);
  // Not throttled by either: the relays are still asked when allowed.
  const found = await fetchProfiles([pubkey], ['wss://quiet.profile']);
  assert.equal(found.get(pubkey)?.name, 'q');
});

test('a batch waits for a lookup already under way rather than skipping the person', async () => {
  const { key, pubkey } = person();
  const relay = fakeRelay('wss://inflight.profile', {
    events: [profileEvent(key, JSON.stringify({ name: 'dave' }))],
  });
  const single = fetchProfile(pubkey, ['wss://inflight.profile'], {
    usePersistentCache: false,
  });
  const batch = fetchProfiles([pubkey], ['wss://inflight.profile']);
  assert.equal((await batch).get(pubkey)?.name, 'dave');
  assert.equal((await single)?.name, 'dave');
  assert.equal(relay.requests.length, 1);
});

test('a lookup started during a batch waits for that batch', async () => {
  const { key, pubkey } = person();
  const relay = fakeRelay('wss://joins.profile', {
    events: [profileEvent(key, JSON.stringify({ name: 'erin' }))],
  });
  const batch = fetchProfiles([pubkey], ['wss://joins.profile']);
  // Let the batch reach the point where it registers its request.
  await new Promise((resolve) => setImmediate(resolve));
  const single = await fetchProfile(pubkey, ['wss://joins.profile'], {
    usePersistentCache: false,
  });
  assert.equal(single?.name, 'erin');
  assert.equal((await batch).get(pubkey)?.name, 'erin');
  assert.equal(relay.requests.length, 1);
});

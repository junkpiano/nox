/**
 * Asking search relays for people: one row per person, the newest profile
 * kept, muted people left out, and a search that stops when it is no longer
 * wanted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { setMuteList } from '../src/common/mute-state.js';
import { EMPTY_MUTE_ENTRIES } from '../src/features/moderation/mute-entries.js';
import { fetchUserSearchHits } from '../src/features/search/user-query.js';
import type { PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

memoryKv();

const alice: Uint8Array = generateSecretKey();
const bob: Uint8Array = generateSecretKey();
const muted: Uint8Array = generateSecretKey();
const ALICE: PubkeyHex = getPublicKey(alice) as PubkeyHex;

setMuteList(
  { ...EMPTY_MUTE_ENTRIES, pubkeys: [getPublicKey(muted) as PubkeyHex] },
  1,
);

test('no query or no relays is no hits, and nothing is asked', async () => {
  const relay = fakeRelay('wss://unused.search');
  assert.deepEqual(
    await fetchUserSearchHits('', ['wss://unused.search'], 10),
    [],
  );
  assert.deepEqual(await fetchUserSearchHits('alice', [], 10), []);
  assert.equal(relay.requests.length, 0);
});

test('one row per person with their newest profile, muted and unreadable ones left out', async () => {
  const one = fakeRelay('wss://one.search', {
    events: [
      signed(alice, {
        kind: 0,
        content: '{"name":"alice old"}',
        created_at: 100,
      }),
      signed(muted, { kind: 0, content: '{"name":"alice muted"}' }),
      signed(bob, { kind: 0, content: 'not json' }),
    ],
  });
  fakeRelay('wss://two.search', {
    events: [
      signed(alice, {
        kind: 0,
        content: '{"name":"alice new"}',
        created_at: 200,
      }),
      signed(alice, {
        kind: 0,
        content: '{"name":"alice older"}',
        created_at: 50,
      }),
    ],
  });
  fakeRelay('wss://down.search', { refuses: true });
  const hits = await fetchUserSearchHits(
    'alice',
    ['wss://one.search', 'wss://two.search', 'wss://down.search'],
    20,
  );
  assert.deepEqual(one.requests[0], { kinds: [0], search: 'alice', limit: 20 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.pubkey, ALICE);
  assert.equal(hits[0]?.npub, nip19.npubEncode(ALICE));
  assert.equal(hits[0]?.profile.name, 'alice new');
  assert.equal(hits[0]?.createdAt, 200);
});

test('a search no longer wanted stops at the next answer', async () => {
  fakeRelay('wss://left.search', {
    events: [
      signed(alice, { kind: 0, content: '{"name":"alice"}' }),
      signed(bob, { kind: 0, content: '{"name":"bob"}' }),
    ],
  });
  let wanted: boolean = true;
  const hits = await fetchUserSearchHits('a', ['wss://left.search'], 10, () => {
    const now: boolean = wanted;
    wanted = false;
    return now;
  });
  // Bob's profile arrived after the page was left, and is not added.
  assert.deepEqual(
    hits.map((hit) => hit.pubkey),
    [ALICE],
  );
});

/**
 * Honouring a deletion, and refusing somebody else's.
 *
 * A kind:5 is an ordinary event that anybody can publish naming anybody's
 * post. Matching on the `e` tag alone would let a stranger clear your posts
 * out of every reader's timeline by asking politely, so the author check is
 * the whole point of this and gets most of the cases below. The signature
 * check closes the other door: a relay answering with a kind:5 that merely
 * carries the author's pubkey.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

import {
  collectDeletedIds,
  fetchDeletedIds,
  withoutDeleted,
} from '../src/common/deleted-events.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import type { NostrEvent } from '../types/nostr';

const aliceKey: Uint8Array = generateSecretKey();
const malloryKey: Uint8Array = generateSecretKey();
const ALICE: string = getPublicKey(aliceKey);

function note(id: string, pubkey: string): NostrEvent {
  return {
    id,
    pubkey,
    kind: 1,
    created_at: 1,
    tags: [],
    content: '',
    sig: '',
  } as NostrEvent;
}

/** A deletion request the key's owner really signed. */
function deletion(
  key: Uint8Array,
  ids: string[],
  tags?: string[][],
): NostrEvent {
  return finalizeEvent(
    {
      kind: 5,
      created_at: 2,
      tags: tags ?? ids.map((id: string): string[] => ['e', id]),
      content: '',
    },
    key,
  ) as unknown as NostrEvent;
}

test('deleted: the author withdrawing their own post counts', () => {
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(aliceKey, ['n1'])]);
  assert.deepEqual(Array.from(deleted), ['n1']);
});

test('deleted: somebody else asking does not', () => {
  // The failure that matters. Anyone can publish a kind:5 naming any event.
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(malloryKey, ['n1'])]);
  assert.equal(deleted.size, 0);
});

test("deleted: a request carrying the author's pubkey but not their signature does not", () => {
  // A hostile relay's move: it cannot sign as Alice, so it answers with a
  // kind:5 that says "Alice" and is signed by nobody, or by Mallory.
  const events = [note('n1', ALICE)];
  // Through JSON, the way a relay delivers it: nostr-tools marks an event it
  // signed itself as verified, and a spread would carry that mark along.
  const asDelivered = (event: NostrEvent): NostrEvent =>
    JSON.parse(JSON.stringify(event)) as NostrEvent;
  const unsigned = asDelivered({
    ...deletion(malloryKey, ['n1']),
    pubkey: ALICE,
  });
  const forged = asDelivered({
    ...deletion(aliceKey, ['n1']),
    sig: 'f'.repeat(128),
  });
  assert.equal(collectDeletedIds(events, [unsigned]).size, 0);
  assert.equal(collectDeletedIds(events, [forged]).size, 0);
});

test('deleted: one request can name several posts', () => {
  const events = [note('n1', ALICE), note('n2', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(aliceKey, ['n1', 'n2'])]);
  assert.equal(deleted.size, 2);
});

test('deleted: a request for something not on screen is ignored', () => {
  // Relays answer generously; that should cost nothing.
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(aliceKey, ['other'])]);
  assert.equal(deleted.size, 0);
});

test('deleted: a non-deletion event is not a deletion', () => {
  const events = [note('n1', ALICE)];
  const notARequest = finalizeEvent(
    { kind: 1, created_at: 2, tags: [['e', 'n1']], content: '' },
    aliceKey,
  ) as unknown as NostrEvent;
  assert.equal(collectDeletedIds(events, [notARequest]).size, 0);
});

test('deleted: malformed tags are skipped', () => {
  const events = [note('n1', ALICE)];
  const broken = deletion(aliceKey, [], [['e'], ['p', ALICE], [], ['e', 'n1']]);
  assert.deepEqual(Array.from(collectDeletedIds(events, [broken])), ['n1']);
});

test('deleted: filtering keeps the order of what is left', () => {
  const events = [note('n1', ALICE), note('n2', ALICE), note('n3', ALICE)];
  const kept = withoutDeleted(events, new Set(['n2']));
  assert.deepEqual(
    kept.map((event) => event.id),
    ['n1', 'n3'],
  );
});

test('deleted: nothing deleted returns the same list', () => {
  const events = [note('n1', ALICE)];
  assert.equal(withoutDeleted(events, new Set()), events);
});

// --- asking the relays ---------------------------------------------------------

test('deleted: silence from every relay is an error, not a clearance', async () => {
  // The real query resolves with an empty list when every relay timed out
  // or refused; only the answered count tells that apart from "nothing was
  // withdrawn". This must surface as a failure so nobody remembers it.
  const events = [note('n1', ALICE)];
  await assert.rejects(
    fetchDeletedIds(['wss://dead'], events, async () => ({
      events: [],
      answered: 0,
    })),
    NoRelayAnsweredError,
  );
});

test('deleted: a relay that answered with nothing clears the batch', async () => {
  const events = [note('n1', ALICE)];
  const deleted = await fetchDeletedIds(['wss://r'], events, async () => ({
    events: [],
    answered: 1,
  }));
  assert.equal(deleted.size, 0);
});

test('deleted: the ids are asked about in chunks, and one silent chunk fails the whole ask', async () => {
  const events: NostrEvent[] = Array.from({ length: 450 }, (_, i) =>
    note(`n${i}`, ALICE),
  );
  const asked: number[] = [];
  let calls: number = 0;
  await assert.rejects(
    fetchDeletedIds(['wss://r'], events, async (_relays, filter) => {
      asked.push((filter['#e'] as string[]).length);
      calls += 1;
      return { events: [], answered: calls === 2 ? 0 : 1 };
    }),
    NoRelayAnsweredError,
  );
  assert.deepEqual(
    asked.sort((a, b) => b - a),
    [200, 200, 50],
  );
});

/**
 * Honouring a deletion, and refusing somebody else's.
 *
 * A kind:5 is an ordinary event that anybody can publish naming anybody's
 * post. Matching on the `e` tag alone would let a stranger clear your posts
 * out of every reader's timeline by asking politely, so the author check is
 * the whole point of this and gets most of the cases below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectDeletedIds,
  withoutDeleted,
} from '../src/common/deleted-events.js';
import type { NostrEvent } from '../types/nostr';

const ALICE = 'a'.repeat(64);
const MALLORY = 'm'.repeat(64);

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

function deletion(pubkey: string, ids: string[]): NostrEvent {
  return {
    id: `del-${pubkey}-${ids.join(',')}`,
    pubkey,
    kind: 5,
    created_at: 2,
    tags: ids.map((id: string): string[] => ['e', id]),
    content: '',
    sig: '',
  } as NostrEvent;
}

test('deleted: the author withdrawing their own post counts', () => {
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(ALICE, ['n1'])]);
  assert.deepEqual(Array.from(deleted), ['n1']);
});

test('deleted: somebody else asking does not', () => {
  // The failure that matters. Anyone can publish a kind:5 naming any event.
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(MALLORY, ['n1'])]);
  assert.equal(deleted.size, 0);
});

test('deleted: one request can name several posts', () => {
  const events = [note('n1', ALICE), note('n2', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(ALICE, ['n1', 'n2'])]);
  assert.equal(deleted.size, 2);
});

test('deleted: a request for something not on screen is ignored', () => {
  // Relays answer generously; that should cost nothing.
  const events = [note('n1', ALICE)];
  const deleted = collectDeletedIds(events, [deletion(ALICE, ['other'])]);
  assert.equal(deleted.size, 0);
});

test('deleted: a non-deletion event is not a deletion', () => {
  const events = [note('n1', ALICE)];
  const notARequest = { ...deletion(ALICE, ['n1']), kind: 1 } as NostrEvent;
  assert.equal(collectDeletedIds(events, [notARequest]).size, 0);
});

test('deleted: malformed tags are skipped', () => {
  const events = [note('n1', ALICE)];
  const broken = {
    ...deletion(ALICE, []),
    tags: [['e'], ['p', ALICE], [], ['e', 'n1']],
  } as NostrEvent;
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

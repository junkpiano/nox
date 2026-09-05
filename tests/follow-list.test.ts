/**
 * Editing a follow list without destroying it.
 *
 * A kind 3 replaces the whole contact list on every relay that accepts it, so
 * a mistake here does not throw - it publishes. These tests exist because that
 * failure lands on the person using the app and cannot be undone by them.
 *
 * The rules were extracted from the web app's follow button so the phone
 * cannot drift from them; these pin the extraction.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFollowing,
  nextFollowListTags,
  UnknownFollowListError,
} from '../src/features/profile/follow-list.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const ME: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
const ALICE: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
const BOB: PubkeyHex = 'c'.repeat(64) as PubkeyHex;

function answered(event: NostrEvent | null) {
  return { event, answered: true };
}

/** Nobody replied: the state in which publishing would destroy a real list. */
const NOBODY_ANSWERED = { event: null, answered: false };

function contactList(tags: string[][], content = ''): NostrEvent {
  return {
    id: 'k3',
    pubkey: ME,
    created_at: 1_700_000_000,
    kind: 3,
    tags,
    content,
    sig: '0'.repeat(128),
  };
}

test('follow list: nobody answering refuses rather than guessing', () => {
  // Every relay failing looks exactly like "you follow nobody". Publishing the
  // second interpretation would wipe the first one's follows everywhere.
  assert.throws(
    () => nextFollowListTags(NOBODY_ANSWERED, ALICE, true),
    UnknownFollowListError,
  );
  assert.throws(
    () => nextFollowListTags(NOBODY_ANSWERED, ALICE, false),
    UnknownFollowListError,
  );
});

test('follow list: a new account can make its first list', () => {
  // Relays answered and there is genuinely no kind 3. Refusing here is what
  // left a brand-new account unable to ever follow anybody - the two meanings
  // of a null event had been collapsed into one.
  const next = nextFollowListTags(answered(null), ALICE, true);
  assert.deepEqual(next, [['p', ALICE]]);
});

test('follow list: unfollowing from an absent list is a no-op, not an error', () => {
  const next = nextFollowListTags(answered(null), ALICE, false);
  assert.deepEqual(next, []);
});

test('follow list: following appends without touching anyone else', () => {
  const current = contactList([
    ['p', ALICE],
    ['p', BOB],
  ]);

  const next = nextFollowListTags(
    answered(current),
    'd'.repeat(64) as PubkeyHex,
    true,
  );

  assert.equal(next.length, 3);
  assert.deepEqual(next[0], ['p', ALICE]);
  assert.deepEqual(next[1], ['p', BOB]);
  assert.deepEqual(next[2], ['p', 'd'.repeat(64)]);
});

test('follow list: unfollowing removes exactly one person', () => {
  const current = contactList([
    ['p', ALICE],
    ['p', BOB],
  ]);

  const next = nextFollowListTags(answered(current), ALICE, false);

  assert.deepEqual(next, [['p', BOB]]);
});

test('follow list: a relay hint and petname on someone else survive', () => {
  // A `p` tag is ['p', pubkey, relay, petname]. Rebuilding it as ['p', pubkey]
  // deletes the other two without anyone noticing until much later.
  const current = contactList([
    ['p', ALICE, 'wss://relay.example.com', 'Alice'],
    ['p', BOB],
  ]);

  const next = nextFollowListTags(answered(current), BOB, false);

  assert.deepEqual(next, [['p', ALICE, 'wss://relay.example.com', 'Alice']]);
});

test('follow list: following someone already followed changes nothing', () => {
  // Re-adding would flatten their existing hint and petname to a bare tag.
  const current = contactList([
    ['p', ALICE, 'wss://relay.example.com', 'Alice'],
  ]);

  const next = nextFollowListTags(answered(current), ALICE, true);

  assert.deepEqual(next, [['p', ALICE, 'wss://relay.example.com', 'Alice']]);
});

test('follow list: tags this client does not understand are kept', () => {
  // Not recognising a tag is not a reason to delete it from someone's list.
  const current = contactList([
    ['p', ALICE],
    ['t', 'bitcoin'],
    ['some-future-tag', 'value'],
  ]);

  const next = nextFollowListTags(answered(current), BOB, true);

  assert.deepEqual(next, [
    ['p', ALICE],
    ['t', 'bitcoin'],
    ['some-future-tag', 'value'],
    ['p', BOB],
  ]);
});

test('follow list: unfollowing keeps the tags it does not understand', () => {
  const current = contactList([
    ['p', ALICE],
    ['t', 'bitcoin'],
  ]);

  const next = nextFollowListTags(answered(current), ALICE, false);

  assert.deepEqual(next, [['t', 'bitcoin']]);
});

test('follow list: the input event is not mutated', () => {
  // The caller still needs the original `content` to carry over.
  const current = contactList([['p', ALICE]], '{"wss://relay":{}}');
  const before = JSON.stringify(current);

  nextFollowListTags(answered(current), BOB, true);

  assert.equal(JSON.stringify(current), before);
});

test('follow list: isFollowing reads the list rather than assuming', () => {
  const current = contactList([['p', ALICE, 'wss://relay.example.com']]);

  assert.equal(isFollowing(current, ALICE), true);
  assert.equal(isFollowing(current, BOB), false);
  // No list is not the same as an empty list, but for a read it is safe to
  // answer "no" - it is only publishing that must refuse.
  assert.equal(isFollowing(null, ALICE), false);
});

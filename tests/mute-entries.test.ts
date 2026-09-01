/**
 * What a mute list contains, and how to change part of it without losing the
 * rest.
 *
 * kind:10000 is replaceable, so publishing one replaces the whole list on
 * every relay that accepts it. A client that rebuilds the entries from only
 * the part it understands does not fail - it publishes, and the rest is gone.
 * These tests exist for that, not for the parsing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchesMutedWord,
  mergeMuteEntries,
  readMuteTags,
  writeMuteTags,
} from '../src/features/moderation/mute-entries.js';
import type { PubkeyHex } from '../types/nostr';

const ALICE = 'a'.repeat(64) as PubkeyHex;
const BOB = 'b'.repeat(64) as PubkeyHex;

// --- reading and writing ---------------------------------------------------

test('mute entries: people and words are read apart', () => {
  const entries = readMuteTags([
    ['p', ALICE],
    ['word', 'spoilers'],
    ['p', BOB],
  ]);

  assert.deepEqual(entries.pubkeys, [ALICE, BOB]);
  assert.deepEqual(entries.words, ['spoilers']);
  assert.deepEqual(entries.otherTags, []);
});

test('mute entries: words are lowercased so matching is predictable', () => {
  assert.deepEqual(readMuteTags([['word', '  SPOILERS  ']]).words, ['spoilers']);
});

test('mute entries: hashtag and event mutes are kept, not understood', () => {
  // This app does not act on `t` or `e`, which is exactly why they must
  // survive: nothing here would notice them disappearing.
  const entries = readMuteTags([
    ['p', ALICE],
    ['t', 'politics'],
    ['e', 'some-event-id'],
  ]);

  assert.deepEqual(entries.otherTags, [
    ['t', 'politics'],
    ['e', 'some-event-id'],
  ]);
});

test('mute entries: a round trip loses nothing', () => {
  const original = [
    ['p', ALICE],
    ['word', 'spoilers'],
    ['t', 'politics'],
    ['e', 'event-id'],
    ['some-future-thing', 'value'],
  ];

  const back = writeMuteTags(readMuteTags(original));

  // Order may change - the parts are regrouped - so compare as sets.
  assert.equal(back.length, original.length);
  for (const tag of original) {
    assert.ok(
      back.some((candidate) => JSON.stringify(candidate) === JSON.stringify(tag)),
      `lost ${JSON.stringify(tag)}`,
    );
  }
});

test('mute entries: adding a person keeps the words', () => {
  // The bug this guards: rebuilding the list from only the pubkeys, which
  // silently deletes every muted word the next time somebody is muted.
  const entries = readMuteTags([
    ['p', ALICE],
    ['word', 'spoilers'],
  ]);

  const withBob = writeMuteTags({ ...entries, pubkeys: [...entries.pubkeys, BOB] });

  assert.ok(withBob.some((t) => t[0] === 'word' && t[1] === 'spoilers'));
  assert.equal(withBob.filter((t) => t[0] === 'p').length, 2);
});

test('mute entries: malformed tags are skipped rather than crashing', () => {
  const entries = readMuteTags([
    ['p'],
    ['word', '   '],
    'not a tag',
    [],
    ['p', ALICE],
  ]);

  assert.deepEqual(entries.pubkeys, [ALICE]);
  assert.deepEqual(entries.words, []);
});

test('mute entries: a non-array is an empty list, not an error', () => {
  assert.deepEqual(readMuteTags(null).pubkeys, []);
  assert.deepEqual(readMuteTags('nonsense').words, []);
});

test('mute entries: merging two readings deduplicates', () => {
  const publicTags = readMuteTags([
    ['p', ALICE],
    ['t', 'politics'],
  ]);
  const privateTags = readMuteTags([
    ['p', ALICE],
    ['p', BOB],
    ['word', 'spoilers'],
    ['t', 'politics'],
  ]);

  const merged = mergeMuteEntries(publicTags, privateTags);

  assert.deepEqual(merged.pubkeys, [ALICE, BOB]);
  assert.deepEqual(merged.words, ['spoilers']);
  assert.deepEqual(merged.otherTags, [['t', 'politics']]);
});

// --- matching --------------------------------------------------------------

test('mute words: a whole word matches, case-insensitively', () => {
  assert.equal(matchesMutedWord('Contains SPOILERS here', ['spoilers']), true);
  assert.equal(matchesMutedWord('nothing to see', ['spoilers']), false);
});

test('mute words: a substring inside another word does not match', () => {
  // Muting "ass" must not hide "class". This is the failure that makes people
  // stop trusting the feature and switch it off.
  assert.equal(matchesMutedWord('a class about it', ['ass']), false);
  assert.equal(matchesMutedWord('that was crass', ['ass']), false);
});

test('mute words: punctuation counts as a boundary', () => {
  assert.equal(matchesMutedWord('spoilers!', ['spoilers']), true);
  assert.equal(matchesMutedWord('(spoilers)', ['spoilers']), true);
  assert.equal(matchesMutedWord('#spoilers', ['spoilers']), true);
});

test('mute words: an empty list matches nothing', () => {
  assert.equal(matchesMutedWord('anything at all', []), false);
});

test('mute words: any one of several is enough', () => {
  assert.equal(
    matchesMutedWord('about the election', ['spoilers', 'election']),
    true,
  );
});

test('mute words: digits are word characters too', () => {
  // "3" inside "s3" is not a word on its own.
  assert.equal(matchesMutedWord('model s3 review', ['s']), false);
  assert.equal(matchesMutedWord('model s 3 review', ['s']), true);
});

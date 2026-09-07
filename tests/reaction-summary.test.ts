/**
 * A reaction is counted only if it is signed, names this post, and has not
 * been withdrawn by the person who made it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { summariseReactions } from '../src/common/reaction-summary.js';
import type { NostrEvent } from '../types/nostr';

const POST = 'a'.repeat(64);
const OTHER_POST = 'b'.repeat(64);
const one = generateSecretKey();
const two = generateSecretKey();

function reaction(
  key: Uint8Array,
  target: string,
  content: string,
  tags: string[][] = [],
): NostrEvent {
  return JSON.parse(
    JSON.stringify(
      finalizeEvent(
        {
          kind: 7,
          created_at: 1000,
          tags: [['e', target], ...tags],
          content,
        },
        key,
      ),
    ),
  ) as NostrEvent;
}

function withdrawal(key: Uint8Array, reactionId: string): NostrEvent {
  return JSON.parse(
    JSON.stringify(
      finalizeEvent(
        { kind: 5, created_at: 1100, tags: [['e', reactionId]], content: '' },
        key,
      ),
    ),
  ) as NostrEvent;
}

test('summary: the same symbol from two people is one row of two', () => {
  const summary = summariseReactions(POST, [
    reaction(one, POST, '+'),
    reaction(two, POST, '+'),
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.count, 2);
  // NIP-25's "+" is kept as the author wrote it, the way the web shows it;
  // only an empty content becomes a heart.
  assert.equal(summary[0]?.content, '+');
});

test('summary: one person pressing twice is still one', () => {
  const summary = summariseReactions(POST, [
    reaction(one, POST, '🔥'),
    { ...reaction(one, POST, '🔥'), id: 'c'.repeat(64) } as NostrEvent,
  ]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.count, 1);
});

test('summary: commonest first', () => {
  const three = generateSecretKey();
  const summary = summariseReactions(POST, [
    reaction(one, POST, '🔥'),
    reaction(two, POST, '👍'),
    reaction(three, POST, '👍'),
  ]);
  assert.deepEqual(
    summary.map((entry) => [entry.content, entry.count]),
    [
      ['👍', 2],
      ['🔥', 1],
    ],
  );
});

test('summary: a reaction to another post, or a forged one, is not counted', () => {
  const forged: NostrEvent = {
    ...reaction(one, POST, '🔥'),
    pubkey: getPublicKey(two),
  };
  const summary = summariseReactions(POST, [
    reaction(one, OTHER_POST, '👍'),
    forged,
  ]);
  assert.deepEqual(summary, []);
});

test('summary: an author withdrawing their own reaction removes it; somebody else cannot', () => {
  const mine = reaction(one, POST, '🔥');
  const theirs = reaction(two, POST, '🔥');
  assert.equal(
    summariseReactions(POST, [mine, theirs], [withdrawal(one, mine.id)])[0]
      ?.count,
    1,
  );
  assert.equal(
    summariseReactions(POST, [mine, theirs], [withdrawal(two, mine.id)])[0]
      ?.count,
    2,
  );
});

test('summary: a custom emoji carries its picture', () => {
  const url = 'https://example.org/party.png';
  const summary = summariseReactions(POST, [
    reaction(one, POST, ':party:', [['emoji', 'party', url]]),
  ]);
  assert.equal(summary[0]?.shortcode, 'party');
  assert.equal(summary[0]?.imageUrl, url);
});

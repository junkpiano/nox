/**
 * The tags that make a reply part of a conversation.
 *
 * Getting NIP-10 wrong does not fail visibly. The reply publishes, it renders,
 * and it is simply detached: no client can place it in the thread and nobody
 * upstream is told about it. That silence is why these are tested rather than
 * eyeballed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { replyTags, repostTags, threadRoot } from '../src/common/reply-tags.js';
import type { NostrEvent } from '../types/nostr';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'e1',
    pubkey: ALICE,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hello',
    sig: '0'.repeat(128),
    ...over,
  };
}

// --- finding the root ----------------------------------------------------

test('reply tags: an event with no e tags is its own root', () => {
  assert.equal(threadRoot(event({ id: 'top' })), 'top');
});

test('reply tags: a marked root wins', () => {
  const parent = event({
    id: 'child',
    tags: [
      ['e', 'the-root', '', 'root'],
      ['e', 'the-parent', '', 'reply'],
    ],
  });
  assert.equal(threadRoot(parent), 'the-root');
});

test('reply tags: with no markers, the first e tag is the root', () => {
  // The positional convention: root first, immediate parent last.
  const parent = event({
    id: 'child',
    tags: [
      ['e', 'the-root'],
      ['e', 'the-parent'],
    ],
  });
  assert.equal(threadRoot(parent), 'the-root');
});

test('reply tags: a lone reply marker names the root it answers', () => {
  // A direct reply to a top-level post carries only `reply`, and what it
  // points at is the root.
  const parent = event({
    id: 'child',
    tags: [['e', 'the-root', '', 'reply']],
  });
  assert.equal(threadRoot(parent), 'the-root');
});

test('reply tags: markers are not second-guessed by position', () => {
  // Reply listed before root. Reading positionally here would pick the wrong
  // one, which is why position is only trusted when nothing is marked.
  const parent = event({
    id: 'child',
    tags: [
      ['e', 'the-parent', '', 'reply'],
      ['e', 'the-root', '', 'root'],
    ],
  });
  assert.equal(threadRoot(parent), 'the-root');
});

// --- building the reply --------------------------------------------------

test('reply tags: replying to a top-level post marks it as the root', () => {
  const tags = replyTags(event({ id: 'top', pubkey: ALICE }));

  assert.deepEqual(
    tags.filter((t: string[]): boolean => t[0] === 'e'),
    [['e', 'top', '', 'root']],
  );
});

test('reply tags: replying to a reply carries the root as well', () => {
  // The bug this module exists for: emitting only the parent loses the thread
  // from the second level down, and no other client can put it back.
  const parent = event({
    id: 'second',
    pubkey: BOB,
    tags: [['e', 'first', '', 'root']],
  });

  const tags = replyTags(parent);

  assert.deepEqual(
    tags.filter((t: string[]): boolean => t[0] === 'e'),
    [
      ['e', 'first', '', 'root'],
      ['e', 'second', '', 'reply'],
    ],
  );
});

test('reply tags: everyone upstream is named, so everyone is told', () => {
  // Only tagging the immediate author means whoever started the thread never
  // hears the answer to it.
  const parent = event({
    id: 'second',
    pubkey: BOB,
    tags: [
      ['e', 'first', '', 'root'],
      ['p', ALICE],
    ],
  });

  const people = replyTags(parent)
    .filter((t: string[]): boolean => t[0] === 'p')
    .map((t: string[]): string => t[1] as string);

  assert.deepEqual(people, [BOB, ALICE]);
});

test('reply tags: the author leads, and nobody is named twice', () => {
  const parent = event({
    id: 'second',
    pubkey: BOB,
    tags: [
      ['p', ALICE],
      ['p', BOB],
      ['p', CAROL],
      ['p', ALICE],
    ],
  });

  const people = replyTags(parent)
    .filter((t: string[]): boolean => t[0] === 'p')
    .map((t: string[]): string => t[1] as string);

  assert.deepEqual(people, [BOB, ALICE, CAROL]);
});

test('reply tags: a three-deep reply still points at the original root', () => {
  const third = event({
    id: 'third',
    pubkey: CAROL,
    tags: [
      ['e', 'first', '', 'root'],
      ['e', 'second', '', 'reply'],
      ['p', ALICE],
      ['p', BOB],
    ],
  });

  const tags = replyTags(third);

  assert.deepEqual(
    tags.filter((t: string[]): boolean => t[0] === 'e'),
    [
      ['e', 'first', '', 'root'],
      ['e', 'third', '', 'reply'],
    ],
  );
});

// --- reposts -------------------------------------------------------------

test('repost tags: name the event and its author', () => {
  const target = event({ id: 'reposted', pubkey: BOB });
  assert.deepEqual(repostTags(target), [
    ['e', 'reposted'],
    ['p', BOB],
  ]);
});

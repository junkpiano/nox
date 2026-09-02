/**
 * Reading a repost without showing anybody a JSON blob.
 *
 * NIP-18 puts the reposted event, serialised, in `content`. A client that
 * renders `content` shows exactly that, which is what the phone was doing -
 * so the cases here are the ones where the embedded copy is missing, broken,
 * or not what it claims to be, because each of those has to degrade into a
 * plain card rather than into `{"id":"...`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isRepost, readRepost, unwrapRepost } from '../src/common/repost.js';
import type { NostrEvent } from '../types/nostr';

const INNER: NostrEvent = {
  id: 'b'.repeat(64),
  pubkey: 'c'.repeat(64),
  created_at: 1700000000,
  kind: 1,
  tags: [],
  content: 'the original post',
  sig: 'd'.repeat(128),
} as NostrEvent;

function repost(content: string, tags: string[][] = []): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 1700000100,
    kind: 6,
    tags,
    content,
    sig: 'f'.repeat(128),
  } as NostrEvent;
}

test('repost: a kind 6 is a repost and a kind 1 is not', () => {
  assert.equal(isRepost(repost('')), true);
  assert.equal(isRepost({ ...repost(''), kind: 1 } as NostrEvent), false);
  assert.equal(isRepost({ ...repost(''), kind: 16 } as NostrEvent), true);
});

test('repost: the embedded event is read out', () => {
  const target = readRepost(repost(JSON.stringify(INNER)));
  assert.equal(target.event?.content, 'the original post');
  assert.equal(target.eventId, INNER.id);
});

test('repost: an empty content falls back to the e tag', () => {
  // Some clients publish the pointer and nothing else. There is still a post
  // to show; it just has to be fetched.
  const target = readRepost(repost('', [['e', INNER.id]]));
  assert.equal(target.event, null);
  assert.equal(target.eventId, INNER.id);
});

test('repost: content that is not JSON does not lose the repost', () => {
  const target = readRepost(repost('nice one', [['e', INNER.id]]));
  assert.equal(target.event, null);
  assert.equal(target.eventId, INNER.id);
});

test('repost: JSON that is not an event is refused', () => {
  // The blob arrived inside somebody else's event. Handing `{"a":1}` on as a
  // post is how a renderer ends up reading `undefined` off it.
  const target = readRepost(repost(JSON.stringify({ a: 1 })));
  assert.equal(target.event, null);
});

test('repost: an event missing its content is refused', () => {
  const { content: _dropped, ...rest } = INNER;
  const target = readRepost(repost(JSON.stringify(rest)));
  assert.equal(target.event, null);
});

test('repost: the last e tag wins', () => {
  // A repost of a reply carries the thread's tags too; the reposted event is
  // the last one.
  const target = readRepost(
    repost('', [
      ['e', 'root'.padEnd(64, '0')],
      ['e', INNER.id],
    ]),
  );
  assert.equal(target.eventId, INNER.id);
});

test('repost: a plain note reports nothing', () => {
  const note = { ...repost('hello'), kind: 1 } as NostrEvent;
  assert.deepEqual(readRepost(note), { event: null, eventId: null });
});

// --- one rule for every screen ----------------------------------------------

test('unwrap: a plain note passes through as itself', () => {
  const note = { ...repost('hello'), kind: 1 } as NostrEvent;
  assert.deepEqual(unwrapRepost(note), {
    event: note,
    repostedBy: null,
    targetId: null,
  });
});

test('unwrap: a repost with a copy resolves to the copy, never its content', () => {
  const wrapped = repost(JSON.stringify(INNER));
  const out = unwrapRepost(wrapped);
  assert.equal(out.event?.content, 'the original post');
  assert.notEqual(out.event?.content, wrapped.content);
  assert.equal(out.repostedBy, wrapped.pubkey);
  assert.equal(out.targetId, INNER.id);
});

test('unwrap: a repost without a copy gives an id and no body', () => {
  // The caller fetches the id. What it must not do is fall back to the
  // wrapper's content, which is exactly the JSON this exists to prevent.
  const out = unwrapRepost(repost('', [['e', INNER.id]]));
  assert.equal(out.event, null);
  assert.equal(out.targetId, INNER.id);
  assert.equal(out.repostedBy, 'e'.repeat(64));
});

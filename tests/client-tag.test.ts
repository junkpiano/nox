/**
 * The rule deciding which events say they came from nox.
 *
 * An allow-list rather than a deny-list, because the events that must never
 * carry an extra tag - relay AUTH, HTTP auth, wallet requests, anything inside
 * a gift wrap - are exactly the ones nobody remembers to exclude.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { withClientTag } from '../src/common/client-tag.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const PUBKEY: PubkeyHex = 'a'.repeat(64) as PubkeyHex;

function unsigned(
  kind: number,
  tags: string[][] = [],
): Omit<NostrEvent, 'id' | 'sig'> {
  return { kind, pubkey: PUBKEY, created_at: 1_700_000_000, tags, content: '' };
}

function clientTags(event: Omit<NostrEvent, 'id' | 'sig'>): string[][] {
  return event.tags.filter((tag: string[]): boolean => tag[0] === 'client');
}

test('posts, reposts and reactions say where they came from', () => {
  for (const kind of [1, 6, 7]) {
    const tagged = withClientTag(unsigned(kind));
    assert.deepEqual(
      clientTags(tagged),
      [['client', 'nox']],
      `kind ${kind} should carry the client tag`,
    );
  }
});

test('events nobody reads are left alone', () => {
  // Deletions, profiles, follow lists, mute lists, relay lists, reports and
  // zap requests are settings or plumbing: a client name on them tells no one
  // anything.
  for (const kind of [0, 3, 5, 1984, 9734, 10000, 10002, 10050]) {
    assert.deepEqual(
      clientTags(withClientTag(unsigned(kind))),
      [],
      `kind ${kind} should not be tagged`,
    );
  }
});

test('authentication events are never touched', () => {
  // A relay verifies 22242 and a media server verifies 27235 against what they
  // asked for. An extra tag is a rejected request, not a cosmetic difference.
  for (const kind of [22242, 27235, 23194]) {
    assert.deepEqual(clientTags(withClientTag(unsigned(kind))), []);
  }
});

test('anything that could reach a gift wrap stays bare', () => {
  // A rumor with identifying metadata defeats the point of sealing it.
  for (const kind of [13, 14, 1059]) {
    assert.deepEqual(clientTags(withClientTag(unsigned(kind))), []);
  }
});

test('an existing client tag is not duplicated', () => {
  const already = unsigned(1, [['client', 'somethingelse']]);
  assert.deepEqual(clientTags(withClientTag(already)), [
    ['client', 'somethingelse'],
  ]);
});

test('the tags already on the event survive, in order', () => {
  const reply = unsigned(1, [
    ['e', 'b'.repeat(64), '', 'root'],
    ['p', 'c'.repeat(64)],
  ]);
  const tagged = withClientTag(reply);

  assert.deepEqual(tagged.tags.slice(0, 2), reply.tags);
  assert.deepEqual(tagged.tags[2], ['client', 'nox']);
});

test('the caller its given event is not mutated', () => {
  const original = unsigned(1);
  const before = JSON.stringify(original);
  withClientTag(original);
  assert.equal(JSON.stringify(original), before);
});

/**
 * A relay's answer is checked before it is believed: the signature, and
 * whether it is an answer to the question asked at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { acceptsEvent, matchesFilter } from '../src/common/event-filter.js';
import type { NostrEvent } from '../types/nostr';

const me = generateSecretKey();
const ME = getPublicKey(me);
const other = generateSecretKey();
const OTHER = getPublicKey(other);

function signed(
  key: Uint8Array,
  kind: number,
  tags: string[][] = [],
  created_at: number = 1000,
): NostrEvent {
  return JSON.parse(
    JSON.stringify(
      finalizeEvent({ kind, tags, content: 'x', created_at }, key),
    ),
  ) as NostrEvent;
}

test('accepts: a genuine event that answers the filter', () => {
  const event = signed(me, 0);
  assert.ok(acceptsEvent({ kinds: [0], authors: [ME] }, event));
});

test('accepts: a forged signature is refused', () => {
  const event = { ...signed(me, 0), content: 'changed' };
  assert.ok(!acceptsEvent({ kinds: [0], authors: [ME] }, event));
});

test('accepts: an event naming somebody else than was asked for is refused', () => {
  const event = signed(other, 0);
  assert.ok(!acceptsEvent({ kinds: [0], authors: [ME] }, event));
  assert.ok(acceptsEvent({ kinds: [0], authors: [ME, OTHER] }, event));
});

test('accepts: the wrong kind is refused; no kinds means any kind', () => {
  const event = signed(me, 1);
  assert.ok(!acceptsEvent({ kinds: [0] }, event));
  assert.ok(acceptsEvent({ authors: [ME] }, event));
});

test('accepts: something that is not an event at all is refused', () => {
  assert.ok(!acceptsEvent({}, null));
  assert.ok(!acceptsEvent({}, { id: 1 }));
  assert.ok(!acceptsEvent({}, { ...signed(me, 1), tags: [[1]] }));
});

test('filter: tag filters, since and until, and id prefixes', () => {
  const target = 'f'.repeat(64);
  const event = signed(me, 7, [['e', target]], 500);
  assert.ok(matchesFilter({ '#e': [target] }, event));
  assert.ok(!matchesFilter({ '#e': ['0'.repeat(64)] }, event));
  assert.ok(!matchesFilter({ '#p': [ME] }, event));
  assert.ok(matchesFilter({ since: 400, until: 600 }, event));
  assert.ok(!matchesFilter({ since: 600 }, event));
  assert.ok(!matchesFilter({ until: 400 }, event));
  assert.ok(matchesFilter({ ids: [event.id.slice(0, 8)] }, event));
  assert.ok(!matchesFilter({ ids: ['0'.repeat(8)] }, event));
  // Keys the filter check does not know are not a reason to refuse.
  assert.ok(matchesFilter({ limit: 5, search: 'x' }, event));
});

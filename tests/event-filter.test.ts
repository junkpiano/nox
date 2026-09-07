/**
 * A relay's answer is checked before it is believed: the signature, and
 * whether it is an answer to the question asked at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from 'nostr-tools';
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

test('accepts: the same event from a second relay is not re-forged', () => {
  // Its own event, so no earlier test can have remembered it already.
  const event = signed(me, 1, [['t', 'second-delivery']]);
  const filter = { kinds: [1], authors: [ME] };
  assert.ok(acceptsEvent(filter, event));
  // A second delivery: a different object, the same content.
  assert.ok(acceptsEvent(filter, JSON.parse(JSON.stringify(event))));
  // An event borrowing that id with different content is still refused.
  assert.ok(
    !acceptsEvent(filter, { ...event, content: 'not what was signed' }),
  );
});

test('accepts: an event cannot claim to have been verified already', () => {
  // nostr-tools writes its answer onto the event object, and a spread
  // carries that mark to a copy. A copy with different content, and its
  // id recomputed so the hash matches, must still be refused - and must
  // not leave that id behind as one that has been checked.
  const event = signed(me, 1, [['t', 'copied-mark']]);
  const filter = { kinds: [1], authors: [ME] };
  assert.ok(acceptsEvent(filter, event));

  const forged = { ...event, content: 'never signed' } as NostrEvent;
  forged.id = getEventHash(forged);
  assert.ok(!acceptsEvent(filter, forged), 'a forged copy is refused');

  // The mark can also be inherited rather than owned, which no amount of
  // deleting own properties would remove.
  const inherited = Object.create(event) as NostrEvent;
  inherited.content = 'never signed either';
  inherited.id = getEventHash(inherited);
  inherited.sig = event.sig;
  assert.ok(!acceptsEvent(filter, inherited), 'an inherited mark is refused');
  assert.ok(
    !acceptsEvent(filter, JSON.parse(JSON.stringify(inherited))),
    'and that content is not remembered as verified',
  );
  // And the wire delivery of that same content, with no mark at all.
  assert.ok(
    !acceptsEvent(filter, JSON.parse(JSON.stringify(forged))),
    'the forged content is not remembered as verified',
  );
});

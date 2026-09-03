/**
 * Reading someone's NIP-38 status.
 *
 * A status is a sentence about right now - "walking the dog", "in a meeting" -
 * and the whole value of showing one is that it is current. Two things decide
 * whether it still is: an `expiration` tag, and failing that, how old the event
 * is. Showing a six month old "back in five minutes" is worse than showing
 * nothing.
 *
 * The text is written by whoever published it, so reading it is defensive for
 * the same reasons the client name is.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUserStatus } from '../src/features/profile/user-status.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const NOW: number = 1_800_000_000;
const DAY: number = 86_400;
const PUBKEY: PubkeyHex = 'a'.repeat(64) as PubkeyHex;

function statusEvent(options: {
  content?: string;
  tags?: string[][];
  createdAt?: number;
}): NostrEvent {
  return {
    id: 'b'.repeat(64),
    pubkey: PUBKEY,
    kind: 30315,
    created_at: options.createdAt ?? NOW - 60,
    tags: options.tags ?? [['d', 'general']],
    content: options.content ?? 'walking the dog',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

test('a recent general status is shown, and says how long it is good for', () => {
  const status = parseUserStatus(statusEvent({}), NOW);
  // Without an expiration, the age limit counted from publication: a reader
  // keeping this around knows when to let go of it.
  assert.deepEqual(status, {
    text: 'walking the dog',
    url: null,
    until: NOW - 60 + 7 * DAY,
  });
});

test('an expiration in the future keeps it, and is when it ends', () => {
  const status = parseUserStatus(
    statusEvent({
      tags: [
        ['d', 'general'],
        ['expiration', String(NOW + 3600)],
      ],
    }),
    NOW,
  );
  assert.equal(status?.text, 'walking the dog');
  assert.equal(status?.until, NOW + 3600);
});

test('an expiration in the past drops it', () => {
  const status = parseUserStatus(
    statusEvent({
      tags: [
        ['d', 'general'],
        ['expiration', String(NOW - 1)],
      ],
      // Recent enough that only the expiration can be doing the work.
      createdAt: NOW - 60,
    }),
    NOW,
  );
  assert.equal(status, null);
});

test('without an expiration, a stale status is dropped anyway', () => {
  // Nobody is still doing what they were doing a month ago, and nobody
  // remembers to clear these.
  assert.ok(parseUserStatus(statusEvent({ createdAt: NOW - DAY }), NOW));
  assert.equal(
    parseUserStatus(statusEvent({ createdAt: NOW - 30 * DAY }), NOW),
    null,
  );
});

test('only the general status is read', () => {
  // A music status is a different thing with different lifetime rules.
  const music = statusEvent({ tags: [['d', 'music']] });
  assert.equal(parseUserStatus(music, NOW), null);

  const noIdentifier = statusEvent({ tags: [] });
  assert.equal(parseUserStatus(noIdentifier, NOW), null);
});

test('an empty status says nothing', () => {
  // Clearing a status is publishing an empty one, so this is the normal way a
  // status ends rather than a malformed event.
  assert.equal(parseUserStatus(statusEvent({ content: '' }), NOW), null);
  assert.equal(parseUserStatus(statusEvent({ content: '   ' }), NOW), null);
});

test('a link on the status is offered, but only an http one', () => {
  const linked = parseUserStatus(
    statusEvent({
      tags: [
        ['d', 'general'],
        ['r', 'https://example.com/track'],
      ],
    }),
    NOW,
  );
  assert.equal(linked?.url, 'https://example.com/track');

  const scripted = parseUserStatus(
    statusEvent({
      tags: [
        ['d', 'general'],
        ['r', 'javascript:alert(1)'],
      ],
    }),
    NOW,
  );
  assert.equal(scripted?.url, null);
});

test('the text cannot take over the layout', () => {
  const long = parseUserStatus(statusEvent({ content: 'x'.repeat(500) }), NOW);
  assert.ok(long);
  assert.ok(long.text.length <= 140, `got ${long.text.length} characters`);
});

test('line breaks and control characters are flattened, not obeyed', () => {
  // One line beside a name. A newline in it is either a mistake or an attempt
  // to take more room than the line.
  const multiline = statusEvent({
    content: ['walking', 'the dog'].join('\n'),
  });
  assert.equal(parseUserStatus(multiline, NOW)?.text, 'walking the dog');

  const tabbed = statusEvent({ content: ['in', 'a', 'meeting'].join('\t') });
  assert.equal(parseUserStatus(tabbed, NOW)?.text, 'in a meeting');
});

/**
 * A thread asks for every reply to its note, whichever way the reply names it.
 *
 * Asked through the same check the relay layer applies to what comes back,
 * so a reply the filters describe is also one the socket lets through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesFilter } from '../src/common/event-filter.js';
import { replyFilters } from '../src/common/events-queries.js';
import type { NostrEvent } from '../types/nostr';

const NOTE: string = 'a'.repeat(64);
const COMMENT: string = 'b'.repeat(64);
const ELSEWHERE: string = 'c'.repeat(64);

function event(kind: number, tags: string[][]): NostrEvent {
  return {
    id: 'd'.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 1_800_000_000,
    kind,
    tags,
    content: 'x',
    sig: 'f'.repeat(128),
  } as NostrEvent;
}

function found(reply: NostrEvent): boolean {
  return replyFilters(NOTE).some((filter: Record<string, unknown>): boolean =>
    matchesFilter(filter, reply),
  );
}

test('replies: a kind 1 reply deep in the thread is found by the note it roots on', () => {
  assert.ok(
    found(
      event(1, [
        ['e', NOTE, '', 'root'],
        ['e', COMMENT, '', 'reply'],
      ]),
    ),
  );
});

test('replies: a comment answering the note is found', () => {
  assert.ok(
    found(
      event(1111, [
        ['E', NOTE],
        ['K', '1'],
        ['e', NOTE],
        ['k', '1'],
      ]),
    ),
  );
});

test('replies: a comment answering a comment is found through the note it roots on', () => {
  assert.ok(
    found(
      event(1111, [
        ['E', NOTE],
        ['K', '1'],
        ['e', COMMENT],
        ['k', '1111'],
      ]),
    ),
  );
});

test('replies: a comment in some other thread is not', () => {
  assert.ok(
    !found(
      event(1111, [
        ['E', ELSEWHERE],
        ['K', '1'],
        ['e', COMMENT],
        ['k', '1111'],
      ]),
    ),
  );
});

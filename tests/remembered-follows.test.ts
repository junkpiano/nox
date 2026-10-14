/**
 * The follow list Home starts from: the signed-in account's own, and never
 * replaced by an older one a slow relay sends.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberedFollows,
  rememberFollowList,
} from '../src/common/events-queries.js';
import { kvSet } from '../src/common/kv.js';
import { VIEWER_KEY } from '../src/common/session.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const me = 'a'.repeat(64) as PubkeyHex;
const other = 'b'.repeat(64) as PubkeyHex;
const list = (
  pubkey: string,
  createdAt: number,
  follows: string[],
): NostrEvent =>
  ({
    id: String(createdAt).padStart(64, '0'),
    pubkey,
    kind: 3,
    created_at: createdAt,
    tags: follows.map((p) => ['p', p]),
    content: '',
    sig: '',
  }) as NostrEvent;

test('keeps the viewer’s list and only a newer one replaces it', () => {
  kvSet(VIEWER_KEY, me);
  assert.equal(rememberedFollows(me), null);
  rememberFollowList(me, list(me, 200, ['c'.repeat(64)]));
  rememberFollowList(me, list(me, 100, ['d'.repeat(64)]));
  assert.deepEqual(rememberedFollows(me), ['c'.repeat(64)]);
  rememberFollowList(me, list(me, 300, ['e'.repeat(64)]));
  assert.deepEqual(rememberedFollows(me), ['e'.repeat(64)]);
});

test('someone else’s list, read for a profile, is not kept', () => {
  kvSet(VIEWER_KEY, me);
  rememberFollowList(other, list(other, 500, ['c'.repeat(64)]));
  assert.equal(rememberedFollows(other), null);
});

test('a list dated in the future is not kept', () => {
  kvSet(VIEWER_KEY, other);
  const tomorrow: number = Math.floor(Date.now() / 1000) + 86_400;
  rememberFollowList(other, list(other, tomorrow, ['c'.repeat(64)]));
  assert.equal(rememberedFollows(other), null);
});

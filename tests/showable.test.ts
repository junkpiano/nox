import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { setMuteList } from '../src/common/mute-state.js';
import { isShowable, showableEvents } from '../src/common/showable.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const muted: Uint8Array = generateSecretKey();
const sign = (
  content: string,
  kind: number = 1,
  key: Uint8Array = generateSecretKey(),
  tags: string[][] = [],
): NostrEvent =>
  finalizeEvent(
    { kind, created_at: 1_700_000_000, tags, content },
    key,
  ) as unknown as NostrEvent;
const repost = (inner: NostrEvent, key?: Uint8Array): NostrEvent =>
  sign(JSON.stringify(inner), 6, key, [
    ['e', inner.id],
    ['p', inner.pubkey],
  ]);

setMuteList(
  { pubkeys: [getPublicKey(muted) as PubkeyHex], words: [], otherTags: [] },
  1,
);

test('an ordinary note and a repost of one are shown', () => {
  const note: NostrEvent = sign('good morning');
  assert.equal(isShowable(note), true);
  assert.equal(isShowable(repost(note)), true);
});

test('a muted author is hidden, on either side of a repost', () => {
  assert.equal(isShowable(sign('hi', 1, muted)), false);
  assert.equal(isShowable(repost(sign('hi', 1, muted))), false);
  assert.equal(isShowable(repost(sign('hi'), muted)), false);
});

test('machine output is hidden, reposted or not', () => {
  const heartbeat: NostrEvent = sign('{"status":"ok"}');
  assert.equal(isShowable(heartbeat), false);
  assert.equal(isShowable(repost(heartbeat)), false);
});

test('a repost whose copy cannot be read waits for its target', () => {
  const forged: NostrEvent = { ...sign('hi'), content: 'edited' };
  assert.equal(isShowable(repost(forged)), true);
});

test('withdrawn events are dropped', () => {
  const a: NostrEvent = sign('a');
  const b: NostrEvent = sign('b');
  assert.deepEqual(showableEvents([a, b], new Set([a.id])), [b]);
});

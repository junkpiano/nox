import assert from 'node:assert/strict';
import test from 'node:test';
import { followedHashtagOf } from '../src/common/interests.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const viewer = 'a'.repeat(64) as PubkeyHex;
const friend = 'b'.repeat(64);
const stranger = 'c'.repeat(64);
const post = (pubkey: string, tags: string[][]): NostrEvent =>
  ({
    id: 'f'.repeat(64),
    pubkey,
    created_at: 1,
    kind: 1,
    tags,
    content: '',
    sig: '',
  }) as NostrEvent;
const follows: Set<string> = new Set([friend]);

test('a stranger’s post names the followed hashtag that brought it in', () => {
  assert.equal(
    followedHashtagOf(
      post(stranger, [
        ['t', 'Nostr'],
        ['t', 'duolingo'],
      ]),
      viewer,
      follows,
      ['duolingo', 'nostr'],
    ),
    'duolingo',
  );
});

test('a post by someone followed, or by the viewer, needs no reason', () => {
  const tagged: string[][] = [['t', 'duolingo']];
  assert.equal(
    followedHashtagOf(post(friend, tagged), viewer, follows, ['duolingo']),
    null,
  );
  assert.equal(
    followedHashtagOf(post(viewer, tagged), viewer, follows, ['duolingo']),
    null,
  );
});

test('a stranger’s post with none of the followed hashtags has none to name', () => {
  assert.equal(
    followedHashtagOf(post(stranger, [['t', 'other']]), viewer, follows, [
      'duolingo',
    ]),
    null,
  );
});

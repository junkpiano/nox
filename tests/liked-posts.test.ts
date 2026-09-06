/**
 * Which likes are believed.
 *
 * Every event a relay sends about your likes is signed by someone, and only
 * the ones signed by you (reactions, withdrawals) or by the post's own
 * author (the post) count. The fixtures are really signed, so the forgeries
 * below are refused by the signature check and not by accident.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { collectLikes, selectLikedEvents } from '../src/common/liked-posts.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const meKey: Uint8Array = generateSecretKey();
const themKey: Uint8Array = generateSecretKey();
const ME: PubkeyHex = getPublicKey(meKey) as PubkeyHex;
const THEM: PubkeyHex = getPublicKey(themKey) as PubkeyHex;

/** Through JSON, the way a relay delivers it: no verified mark rides along. */
function delivered(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function note(key: Uint8Array, content: string): NostrEvent {
  return delivered(
    finalizeEvent(
      { kind: 1, created_at: 1, tags: [], content },
      key,
    ) as unknown as NostrEvent,
  );
}

function reaction(key: Uint8Array, target: NostrEvent, at: number): NostrEvent {
  return delivered(
    finalizeEvent(
      {
        kind: 7,
        created_at: at,
        tags: [
          ['e', target.id],
          ['p', target.pubkey],
        ],
        content: '+',
      },
      key,
    ) as unknown as NostrEvent,
  );
}

function deletion(key: Uint8Array, ids: string[]): NostrEvent {
  return delivered(
    finalizeEvent(
      {
        kind: 5,
        created_at: 99,
        tags: ids.map((id: string): string[] => ['e', id]),
        content: '',
      },
      key,
    ) as unknown as NostrEvent,
  );
}

const postA: NostrEvent = note(themKey, 'a');
const postB: NostrEvent = note(themKey, 'b');

test('likes: newest first, one row per post, the later reaction standing for it', () => {
  const likes = collectLikes(
    ME,
    [
      reaction(meKey, postA, 10),
      reaction(meKey, postB, 20),
      reaction(meKey, postA, 30),
    ],
    [],
  );
  assert.deepEqual(
    likes.map((like) => [like.targetId, like.reaction.created_at]),
    [
      [postA.id, 30],
      [postB.id, 20],
    ],
  );
  assert.equal(likes[0]?.targetAuthor, THEM);
});

test('likes: a reaction you withdrew is gone; somebody else cannot withdraw it', () => {
  const r1: NostrEvent = reaction(meKey, postA, 10);
  const r2: NostrEvent = reaction(meKey, postB, 20);
  const likes = collectLikes(
    ME,
    [r1, r2],
    [deletion(meKey, [r1.id]), deletion(themKey, [r2.id])],
  );
  assert.deepEqual(
    likes.map((like) => like.targetId),
    [postB.id],
  );
});

test('likes: a reaction carrying your pubkey but not your signature is not yours', () => {
  // The relay's lie: a kind 7 that says "you", signed by somebody else, or
  // by you and then edited.
  const impostor: NostrEvent = { ...reaction(themKey, postA, 10), pubkey: ME };
  const edited: NostrEvent = { ...reaction(meKey, postA, 10), content: '-' };
  const theirs: NostrEvent = reaction(themKey, postA, 10);
  assert.deepEqual(collectLikes(ME, [impostor, edited, theirs], []), []);
});

test('likes: a withdrawal carrying your pubkey but not your signature does not withdraw', () => {
  const r1: NostrEvent = reaction(meKey, postA, 10);
  const forgedDeletion: NostrEvent = {
    ...deletion(themKey, [r1.id]),
    pubkey: ME,
  };
  assert.equal(collectLikes(ME, [r1], [forgedDeletion]).length, 1);
});

test('likes: only reactions that name a post count', () => {
  const notAReaction: NostrEvent = note(meKey, 'not a reaction');
  const namesNothing: NostrEvent = delivered(
    finalizeEvent(
      { kind: 7, created_at: 5, tags: [['p', THEM]], content: '+' },
      meKey,
    ) as unknown as NostrEvent,
  );
  assert.deepEqual(collectLikes(ME, [notAReaction, namesNothing], []), []);
});

test('likes: the posts shown are the ones asked for, genuine, in like order', () => {
  const likes = collectLikes(
    ME,
    [reaction(meKey, postA, 10), reaction(meKey, postB, 20)],
    [],
  );
  const stranger: NostrEvent = note(themKey, 'never liked');
  const forgedA: NostrEvent = { ...postA, content: 'words they never wrote' };
  const shown = selectLikedEvents(likes, [stranger, forgedA, postA, postB]);
  assert.deepEqual(
    shown.map((event) => event.id),
    [postB.id, postA.id],
  );
  assert.equal(shown[1]?.content, 'a');
});

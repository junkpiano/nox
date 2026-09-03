import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLikes } from '../src/common/liked-posts.js';
import type { NostrEvent } from '../types/nostr';

const ME = 'a'.repeat(64);
const THEM = 'b'.repeat(64);

function reaction(
  id: string,
  target: string,
  at: number,
  extra: string[][] = [],
): NostrEvent {
  return {
    id,
    pubkey: ME,
    kind: 7,
    created_at: at,
    tags: [['e', target], ['p', THEM], ...extra],
    content: '+',
    sig: '',
  } as NostrEvent;
}

function deletion(by: string, ids: string[]): NostrEvent {
  return {
    id: `del-${ids.join('-')}`,
    pubkey: by,
    kind: 5,
    created_at: 99,
    tags: ids.map((id: string): string[] => ['e', id]),
    content: '',
    sig: '',
  } as NostrEvent;
}

test('likes: newest first, one row per post, the later reaction standing for it', () => {
  const likes = collectLikes(
    [
      reaction('r1', 'post-a', 10),
      reaction('r2', 'post-b', 20),
      reaction('r3', 'post-a', 30),
    ],
    [],
  );
  assert.deepEqual(
    likes.map((like) => [like.targetId, like.reaction.id]),
    [
      ['post-a', 'r3'],
      ['post-b', 'r2'],
    ],
  );
  assert.equal(likes[0]?.targetAuthor, THEM);
});

test('likes: a reaction you withdrew is gone; somebody else cannot withdraw it', () => {
  const likes = collectLikes(
    [reaction('r1', 'post-a', 10), reaction('r2', 'post-b', 20)],
    [deletion(ME, ['r1']), deletion(THEM, ['r2'])],
  );
  assert.deepEqual(
    likes.map((like) => like.targetId),
    ['post-b'],
  );
});

test('likes: only reactions that name a post count', () => {
  const notAReaction = { ...reaction('x', 'post-a', 5), kind: 1 } as NostrEvent;
  const namesNothing = {
    ...reaction('y', 'post-a', 5),
    tags: [['p', THEM]],
  } as NostrEvent;
  assert.deepEqual(collectLikes([notAReaction, namesNothing], []), []);
});

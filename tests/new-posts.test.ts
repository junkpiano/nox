import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNewPostsBuffer,
  type NewPostsBuffer,
  newPostsLabel,
  nextSince,
} from '../src/common/new-posts.js';

interface Post {
  id: string;
  at: number;
}

function buffer(shown: Set<string>): NewPostsBuffer<Post> {
  return createNewPostsBuffer<Post>({
    keyOf: (post: Post): string => post.id,
    isShown: (key: string): boolean => shown.has(key),
    createdAt: (post: Post): number => post.at,
  });
}

// --- what counts as new ------------------------------------------------------

test('new posts: a post already on screen is not new', () => {
  const pending = buffer(new Set(['a']));
  assert.equal(
    pending.add([
      { id: 'a', at: 10 },
      { id: 'b', at: 11 },
    ]),
    1,
  );
  assert.deepEqual(pending.take(), [{ id: 'b', at: 11 }]);
});

test('new posts: the same post arriving twice is counted once', () => {
  // Every relay sends its copy, and the poll runs again before a tap.
  const pending = buffer(new Set());
  pending.add([{ id: 'a', at: 10 }]);
  assert.equal(pending.add([{ id: 'a', at: 10 }]), 1);
  assert.equal(pending.add([{ id: 'b', at: 12 }]), 2);
});

test('new posts: the count grows as more arrive, without losing the earlier ones', () => {
  const pending = buffer(new Set());
  pending.add([{ id: 'a', at: 10 }]);
  pending.add([
    { id: 'b', at: 12 },
    { id: 'c', at: 11 },
  ]);
  assert.equal(pending.count(), 3);
});

// --- letting them in ----------------------------------------------------------

test('new posts: take() hands them over newest first and empties the buffer', () => {
  const pending = buffer(new Set());
  pending.add([
    { id: 'a', at: 10 },
    { id: 'c', at: 12 },
    { id: 'b', at: 11 },
  ]);
  assert.deepEqual(
    pending.take().map((post: Post): string => post.id),
    ['c', 'b', 'a'],
  );
  assert.equal(pending.count(), 0);
  assert.deepEqual(pending.take(), []);
});

test('new posts: clear() forgets what was waiting', () => {
  // A full reload shows everything, so nothing is waiting any more.
  const pending = buffer(new Set());
  pending.add([{ id: 'a', at: 10 }]);
  pending.clear();
  assert.equal(pending.count(), 0);
});

// --- the row's words ----------------------------------------------------------

test('new posts: the label counts in plain words', () => {
  assert.equal(newPostsLabel(1), '1 new post');
  assert.equal(newPostsLabel(12), '12 new posts');
});

test('new posts: polling resumes one second past the newest shown post', () => {
  assert.equal(nextSince(1700000000), 1700000001);
  assert.equal(nextSince(null), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  judgePage,
  MAX_HELD_POSTS,
  mergePosts,
  nextUntil,
  oldestOf,
} from '../src/common/timeline-paging.js';

const at = (id: string, created_at: number) => ({ id, created_at });

// --- the cursor ---------------------------------------------------------------

test('paging: the next page is asked for from one second before the oldest', () => {
  assert.equal(nextUntil(1700000000), 1699999999);
  assert.equal(nextUntil(null), null);
});

test('paging: oldestOf finds the earliest moment', () => {
  assert.equal(oldestOf([at('a', 30), at('b', 10), at('c', 20)]), 10);
  assert.equal(oldestOf([]), null);
});

// --- when to stop --------------------------------------------------------------

test('paging: an empty page means there is nothing older', () => {
  const j = judgePage({
    previousOldest: 100,
    page: [],
    newIds: 0,
    heldAfter: 50,
  });
  assert.equal(j.hasMore, false);
  assert.equal(j.end, 'exhausted');
  assert.equal(j.oldestCreatedAt, 100);
});

test('paging: a page of posts already held means there is nothing older', () => {
  // A relay that ignores `until` sends the same page again.
  const j = judgePage({
    previousOldest: 100,
    page: [at('a', 90), at('b', 80)],
    newIds: 0,
    heldAfter: 50,
  });
  assert.equal(j.hasMore, false);
  assert.equal(j.end, 'exhausted');
});

test('paging: a page that does not move the cursor back stops the reading', () => {
  const j = judgePage({
    previousOldest: 100,
    page: [at('x', 100), at('y', 120)],
    newIds: 2,
    heldAfter: 52,
  });
  assert.equal(j.hasMore, false);
  assert.equal(j.end, 'stalled');
  assert.equal(j.oldestCreatedAt, 100);
});

test('paging: a page that moves the cursor back continues', () => {
  const j = judgePage({
    previousOldest: 100,
    page: [at('a', 90), at('b', 70)],
    newIds: 2,
    heldAfter: 52,
  });
  assert.equal(j.hasMore, true);
  assert.equal(j.end, null);
  assert.equal(j.oldestCreatedAt, 70);
});

test('paging: reaching the holding limit stops the reading', () => {
  const j = judgePage({
    previousOldest: 100,
    page: [at('a', 90)],
    newIds: 1,
    heldAfter: MAX_HELD_POSTS,
  });
  assert.equal(j.hasMore, false);
  assert.equal(j.end, 'cap');
  assert.equal(j.oldestCreatedAt, 90);
});

test('paging: the first page ever has no previous cursor to stall against', () => {
  const j = judgePage({
    previousOldest: null,
    page: [at('a', 90)],
    newIds: 1,
    heldAfter: 1,
  });
  assert.equal(j.hasMore, true);
  assert.equal(j.oldestCreatedAt, 90);
});

// --- the merge -----------------------------------------------------------------

test('paging: merging keeps each post once, newest first, the existing copy winning', () => {
  const existing = [
    { key: 'a', t: 30, from: 'old' },
    { key: 'b', t: 20, from: 'old' },
  ];
  const incoming = [
    { key: 'b', t: 20, from: 'new' },
    { key: 'c', t: 10, from: 'new' },
    { key: 'd', t: 40, from: 'new' },
  ];
  const merged = mergePosts(
    existing,
    incoming,
    (p) => p.key,
    (p) => p.t,
  );
  assert.deepEqual(
    merged.map((p) => `${p.key}:${p.from}`),
    ['d:new', 'a:old', 'b:old', 'c:new'],
  );
});

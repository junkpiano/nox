/**
 * A session memo that forgets its oldest entry instead of growing forever.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setCapped } from '../src/common/capped-map.js';

test('a full map forgets the oldest key to make room for a new one', () => {
  const map: Map<string, number> = new Map();
  setCapped(map, 'a', 1, 2);
  setCapped(map, 'b', 2, 2);
  setCapped(map, 'c', 3, 2);
  assert.deepEqual(Array.from(map.entries()), [
    ['b', 2],
    ['c', 3],
  ]);
});

test('replacing a key already held forgets nothing', () => {
  const map: Map<string, number> = new Map([
    ['a', 1],
    ['b', 2],
  ]);
  setCapped(map, 'a', 10, 2);
  assert.deepEqual(Array.from(map.entries()), [
    ['a', 10],
    ['b', 2],
  ]);
});

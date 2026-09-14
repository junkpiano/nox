/**
 * Waiting for the next task hands the thread back.
 *
 * The property the message backfill and the repost check rely on: awaiting
 * this lets work that was already queued - a tap, as far as the thread is
 * concerned - run first.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTask } from '../src/common/promise-utils.js';

test('next task: work already queued runs before the await returns', async () => {
  const seen: string[] = [];
  setTimeout((): void => {
    seen.push('queued');
  }, 0);
  await Promise.resolve();
  assert.equal(seen.length, 0, 'a settled promise does not let it in');
  await nextTask();
  seen.push('after');
  assert.deepEqual(seen, ['queued', 'after']);
});

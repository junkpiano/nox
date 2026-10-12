/**
 * What a share link hands the composer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { shareTextFrom } from '../src/common/share-draft.js';

const read = (query: string): string | null =>
  shareTextFrom(new URLSearchParams(query));

test('content is taken as written, decoded', () => {
  assert.equal(
    read('content=Hello%20%23nostr%20https%3A%2F%2Fx.dev'),
    'Hello #nostr https://x.dev',
  );
});

test('a share sheet sends text and url; both are kept, in that order', () => {
  assert.equal(
    read('text=A%20title&url=https%3A%2F%2Fx.dev'),
    'A title https://x.dev',
  );
  assert.equal(read('url=https%3A%2F%2Fx.dev'), 'https://x.dev');
});

test('content wins over text and url', () => {
  assert.equal(read('content=mine&text=theirs'), 'mine');
});

test('nothing to share is null', () => {
  assert.equal(read(''), null);
  assert.equal(read('content=%20%20'), null);
});

test('a very long text is cut, not refused', () => {
  assert.equal(read(`content=${'a'.repeat(20000)}`)?.length, 10000);
});

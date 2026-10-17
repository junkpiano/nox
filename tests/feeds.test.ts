/**
 * What a timeline asks for: notes and reposts, by person or by hashtag.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEED_KINDS,
  FEED_LIMIT,
  hashtagFeedFilter,
  userFeedFilter,
} from '../src/common/feeds.js';
import { PAGE_LIMIT } from '../src/common/timeline-paging.js';

test('a timeline asks for notes and both kinds of repost, a page at a time', () => {
  assert.deepEqual(FEED_KINDS, [1, 6, 16]);
  assert.equal(FEED_LIMIT, PAGE_LIMIT);
});

test('a hashtag feed asks for notes with the tag lowercased', () => {
  assert.deepEqual(hashtagFeedFilter('Nostr'), {
    kinds: [1],
    '#t': ['nostr'],
  });
});

test("a person's feed asks for their notes and reposts", () => {
  assert.deepEqual(userFeedFilter('abc'), {
    kinds: [1, 6, 16],
    authors: ['abc'],
  });
});

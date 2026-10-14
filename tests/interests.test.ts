/**
 * Followed hashtags: the NIP-51 interests list is edited without losing what
 * else it holds, and Home asks for tagged posts beside followed people.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashtagsOf,
  homeFilters,
  nextInterestTags,
} from '../src/common/interests.js';

test('following adds one lowercase t tag and keeps the rest', () => {
  const tags = [
    ['t', 'nostr'],
    ['a', '30015:abc:food'],
  ];
  assert.deepEqual(nextInterestTags(tags, '#Rust', true), [
    ['t', 'nostr'],
    ['a', '30015:abc:food'],
    ['t', 'rust'],
  ]);
  // Following twice does not list it twice.
  assert.deepEqual(
    hashtagsOf(nextInterestTags([['t', 'rust']], 'RUST', true)),
    ['rust'],
  );
});

test('unfollowing removes every spelling of the tag and nothing else', () => {
  const tags = [
    ['t', 'Rust'],
    ['t', 'nostr'],
    ['t', 'rust'],
  ];
  assert.deepEqual(nextInterestTags(tags, 'rust', false), [['t', 'nostr']]);
});

test('Home asks for tagged posts only when there are hashtags', () => {
  assert.deepEqual(homeFilters([1, 6], ['p1'], []), [
    { kinds: [1, 6], authors: ['p1'] },
  ]);
  assert.deepEqual(homeFilters([1, 6], ['p1'], ['rust']), [
    { kinds: [1, 6], authors: ['p1'] },
    { kinds: [1], '#t': ['rust'] },
  ]);
});

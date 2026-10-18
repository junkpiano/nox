import assert from 'node:assert/strict';
import test from 'node:test';
import { hashtagQuery } from '../src/common/interests.js';

test('a #word is a hashtag, lowercased without its #', () => {
  assert.equal(hashtagQuery('#Duolingo'), 'duolingo');
  assert.equal(hashtagQuery('  #nostr  '), 'nostr');
  assert.equal(hashtagQuery('#日本語'), '日本語');
  assert.equal(hashtagQuery('#743'), '743');
});

test('a plain word, a phrase or a bare # is not', () => {
  assert.equal(hashtagQuery('duolingo'), null);
  assert.equal(hashtagQuery('#two words'), null);
  assert.equal(hashtagQuery('#'), null);
  assert.equal(hashtagQuery('##'), null);
  assert.equal(hashtagQuery('#!!!'), null);
  assert.equal(hashtagQuery('#c++'), null);
  assert.equal(hashtagQuery('#_-'), null);
  assert.equal(hashtagQuery('#web-dev'), 'web-dev');
  assert.equal(hashtagQuery(''), null);
});

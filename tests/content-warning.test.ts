/**
 * Reading a warning the author put on their own post.
 *
 * NIP-36 is one of the few places on Nostr where somebody has said in advance
 * "do not show this to people who have not asked for it". Missing one is not a
 * rendering glitch; it puts something in front of a reader that its own author
 * had marked. So the shapes are pinned rather than trusted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contentWarningSummary,
  getContentWarning,
} from '../src/common/content-warning.js';
import type { NostrEvent } from '../types/nostr';

function event(tags: string[][]): NostrEvent {
  return {
    id: 'e1',
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags,
    content: 'something',
    sig: '0'.repeat(128),
  };
}

test('content warning: an untagged post is not warned', () => {
  assert.equal(getContentWarning(event([])).hasWarning, false);
  assert.equal(
    getContentWarning(event([['p', 'b'.repeat(64)]])).hasWarning,
    false,
  );
});

test('content warning: the NIP-36 tag, with and without a reason', () => {
  assert.deepEqual(getContentWarning(event([['content-warning']])), {
    hasWarning: true,
    reason: '',
  });
  assert.deepEqual(getContentWarning(event([['content-warning', 'nsfw']])), {
    hasWarning: true,
    reason: 'nsfw',
  });
});

test('content warning: the "cw" shorthand other clients write', () => {
  // Reading only the spelled-out tag would leave posts warned by other
  // clients uncovered, and being generous here costs nothing.
  assert.deepEqual(getContentWarning(event([['cw', 'violence']])), {
    hasWarning: true,
    reason: 'violence',
  });
});

test('content warning: case is ignored on the tag name', () => {
  assert.equal(
    getContentWarning(event([['Content-Warning', 'x']])).hasWarning,
    true,
  );
});

test('content warning: a NIP-32 label in the content-warning namespace', () => {
  const warned = event([
    ['L', 'content-warning'],
    ['l', 'graphic', 'content-warning'],
  ]);
  assert.deepEqual(getContentWarning(warned), {
    hasWarning: true,
    reason: 'graphic',
  });
});

test('content warning: a label in some other namespace is not a warning', () => {
  // `l` tags are used for all sorts of labelling. Only the content-warning
  // namespace means this.
  const labelled = event([
    ['L', 'language'],
    ['l', 'en', 'language'],
  ]);
  assert.equal(getContentWarning(labelled).hasWarning, false);
});

test('content warning: the namespace alone is enough, even with no label', () => {
  assert.equal(
    getContentWarning(event([['L', 'content-warning']])).hasWarning,
    true,
  );
});

test('content warning: the first reason given wins, and none is invented', () => {
  const warned = event([
    ['content-warning', 'first'],
    ['cw', 'second'],
  ]);
  assert.equal(getContentWarning(warned).reason, 'first');
  assert.equal(getContentWarning(event([['content-warning']])).reason, '');
});

test('content warning: an empty tag does not crash or count', () => {
  assert.equal(getContentWarning(event([[], ['']])).hasWarning, false);
});

// --- the line shown in place of the post ---------------------------------

test('content warning summary: no reason gives a plain line', () => {
  assert.equal(
    contentWarningSummary({ hasWarning: true, reason: '' }),
    'Content warning',
  );
});

test('content warning summary: the reason is the author\'s own words', () => {
  assert.equal(
    contentWarningSummary({ hasWarning: true, reason: 'nsfw' }),
    'Content warning: nsfw',
  );
});

test('content warning summary: a multi-line reason is flattened', () => {
  // The reason is a string its author chose. A newline here would let the
  // label push the post it is covering back into view.
  const summary = contentWarningSummary({
    hasWarning: true,
    reason: 'line one\nline two',
  });
  assert.equal(summary, 'Content warning: line one line two');
  assert.ok(!summary.includes('\n'));
});

test('content warning summary: a very long reason is cut', () => {
  const summary = contentWarningSummary({
    hasWarning: true,
    reason: 'x'.repeat(500),
  });
  assert.ok(summary.length < 120);
});

test('content warning summary: whitespace-only reason falls back', () => {
  assert.equal(
    contentWarningSummary({ hasWarning: true, reason: '   \n  ' }),
    'Content warning',
  );
});

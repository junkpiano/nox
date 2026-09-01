/**
 * What counts as a link inside somebody's post.
 *
 * The invariant that matters most is the boring one: the segments must
 * reassemble into exactly the string that went in. A renderer that walks them
 * cannot then silently swallow part of what somebody wrote, which is the
 * failure mode of every "find the links" pass that rebuilds text as it goes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContentSegment } from '../src/common/content-segments.js';
import {
  parseContentSegments,
  partitionContent,
} from '../src/common/content-segments.js';

const NPUB: string =
  'npub1paptfd5xjegzpnkzexxpw3npsaaw30pah8fyyuhyfz4mhv2ywcmsn5tp2u';

function rebuild(segments: ContentSegment[]): string {
  return segments.map((segment: ContentSegment): string => segment.text).join('');
}

test('segments: plain text is one segment', () => {
  const segments = parseContentSegments('just a sentence');
  assert.deepEqual(segments, [{ kind: 'text', text: 'just a sentence' }]);
});

test('segments: an empty string has no segments', () => {
  assert.deepEqual(parseContentSegments(''), []);
});

test('segments: a link is found and kept whole', () => {
  const segments = parseContentSegments('see https://example.com/a?b=1 ok');
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1], {
    kind: 'url',
    text: 'https://example.com/a?b=1',
    url: 'https://example.com/a?b=1',
    media: null,
  });
});

test('segments: a full stop after a link is a sentence, not a link', () => {
  const segments = parseContentSegments('read https://example.com/page.');
  const url = segments.find((s) => s.kind === 'url');
  assert.equal(url?.text, 'https://example.com/page');
  assert.equal(rebuild(segments), 'read https://example.com/page.');
});

test('segments: a bracket the link opened is kept', () => {
  // en.wikipedia.org/wiki/Foo_(bar) is a real address and trimming its tail
  // breaks the link rather than tidying it.
  const segments = parseContentSegments(
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  );
  assert.equal(segments[0]?.text, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('segments: a nostr mention decodes to a pubkey', () => {
  const segments = parseContentSegments(`hi nostr:${NPUB} there`);
  const mention = segments.find((s) => s.kind === 'mention');
  assert.ok(mention && mention.kind === 'mention');
  assert.match(mention.pubkey ?? '', /^[0-9a-f]{64}$/);
  assert.equal(mention.text, `nostr:${NPUB}`);
});

test('segments: a bare npub is left as text', () => {
  // Somebody quoting a key is not linking to one, and linking every mention
  // of a key makes a post about keys unreadable.
  const segments = parseContentSegments(`my key is ${NPUB}`);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, 'text');
});

test('segments: an undecodable reference is still a segment', () => {
  // It renders as itself rather than as a link to nowhere, and it must not
  // throw on the way there.
  const segments = parseContentSegments('nostr:npub1thisisnotvalid');
  const mention = segments.find((s) => s.kind === 'mention');
  assert.ok(mention && mention.kind === 'mention');
  assert.equal(mention.pubkey, null);
});

test('segments: a quoted note becomes an event segment', () => {
  const segments = parseContentSegments(
    'look nostr:note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm8jm4x',
  );
  const quoted = segments.find((s) => s.kind === 'event');
  assert.ok(quoted && quoted.kind === 'event');
});

test('segments: several references in one post keep their order', () => {
  const content = `a https://one.example b nostr:${NPUB} c https://two.example d`;
  const kinds = parseContentSegments(content).map((s) => s.kind);
  assert.deepEqual(kinds, [
    'text',
    'url',
    'text',
    'mention',
    'text',
    'url',
    'text',
  ]);
});

test('segments: nothing is lost, whatever is in the post', () => {
  // The one property a renderer is allowed to rely on.
  const samples: string[] = [
    'plain',
    `nostr:${NPUB}`,
    `start nostr:${NPUB} end`,
    'https://a.example, https://b.example.',
    `mixed https://x.example nostr:${NPUB} (https://y.example)`,
    'nostr:npub1broken and https://ok.example',
    'trailing https://a.example',
    'nostr:',
    '',
  ];
  for (const sample of samples) {
    assert.equal(rebuild(parseContentSegments(sample)), sample, sample);
  }
});

// --- media, which belongs under the post rather than inside the sentence ----

test('segments: a picture link is marked as one', () => {
  const segments = parseContentSegments('https://host.example/cat.jpg');
  assert.equal(segments[0]?.kind, 'url');
  assert.equal(
    segments[0]?.kind === 'url' ? segments[0].media : null,
    'image',
  );
});

test('segments: a video link is not marked as a picture', () => {
  // These were one branch once, which put a video in an <img>: the browser
  // downloads the whole file before finding out it cannot decode it.
  const segments = parseContentSegments('https://host.example/clip.mp4');
  assert.equal(
    segments[0]?.kind === 'url' ? segments[0].media : null,
    'video',
  );
});

test('partition: media comes out of the prose', () => {
  const { segments, media } = partitionContent(
    'look at this https://host.example/cat.jpg nice',
  );
  assert.deepEqual(media, [
    { url: 'https://host.example/cat.jpg', kind: 'image' },
  ]);
  const text = segments.map((s) => s.text).join('');
  assert.ok(!text.includes('http'), 'the URL is gone from the text');
  assert.ok(text.includes('look at this'), 'the sentence is not');
});

test('partition: a post that is only a picture has no text left', () => {
  // Otherwise the card shows a blank line above the image.
  const { segments, media } = partitionContent('https://host.example/cat.jpg');
  assert.deepEqual(segments, []);
  assert.equal(media.length, 1);
});

test('partition: a plain link stays in the text', () => {
  const { segments, media } = partitionContent('read https://example.com/page');
  assert.deepEqual(media, []);
  assert.ok(segments.some((s) => s.kind === 'url'));
});

test('partition: several pictures keep their order', () => {
  const { media } = partitionContent(
    'a https://h.example/1.png b https://h.example/2.gif',
  );
  assert.deepEqual(
    media.map((m) => m.url),
    ['https://h.example/1.png', 'https://h.example/2.gif'],
  );
});

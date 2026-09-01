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
  return segments
    .map((segment: ContentSegment): string => segment.text)
    .join('');
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
  assert.equal(segments[0]?.kind === 'url' ? segments[0].media : null, 'image');
});

test('segments: a video link is not marked as a picture', () => {
  // These were one branch once, which put a video in an <img>: the browser
  // downloads the whole file before finding out it cannot decode it.
  const segments = parseContentSegments('https://host.example/clip.mp4');
  assert.equal(segments[0]?.kind === 'url' ? segments[0].media : null, 'video');
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

test('segments: a number is not a hashtag', () => {
  // "WORD5 #695 5/6" is a Wordle score. Linking it sends the reader to an
  // empty search for a number nobody tagged anything with.
  const segments = parseContentSegments('WORD5 #695 5/6');
  assert.ok(!segments.some((s) => s.kind === 'hashtag'));
  assert.equal(rebuild(segments), 'WORD5 #695 5/6');
});

test('segments: a tag with digits in it is still a tag', () => {
  const segments = parseContentSegments('about #web3 today');
  const tag = segments.find((s) => s.kind === 'hashtag');
  assert.ok(tag && tag.kind === 'hashtag');
  assert.equal(tag.tag, 'web3');
});

// --- quotes ------------------------------------------------------------------

// A real encoding of 'ab' * 32, so it decodes. A made-up bech32 fails its
// checksum and lands in the "stays in the text" case instead.
const NOTE_REF =
  'note14w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4sfreljc';
// The same id as an nevent with one relay hint, and one with a hint that
// is not a relay. Generated with nip19.neventEncode; see the comment above
// about why a made-up bech32 does not work here.
const NEVENT_REF =
  'nevent1qy28wumn8ghj76rfde6x2epwv4uxzmtsd3jsqg9t4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4vvnu2an';
const NEVENT_BAD_HINT =
  'nevent1qyfk5ctkv9ekxunfwp6r5ctvv4e8g2p39yqzp2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2atmqtqlt';

test('partition: a quoted note comes out of the prose', () => {
  const { segments, media, quotes } = partitionContent(
    `look at this nostr:${NOTE_REF} amazing`,
  );
  assert.equal(quotes.length, 1);
  assert.match(quotes[0]?.id ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(quotes[0]?.relays, [], 'a bare note carries no hints');
  const text = segments.map((s) => s.text).join('');
  assert.ok(!text.includes('note1'), 'the reference is gone from the text');
  assert.ok(text.includes('look at this'));
  assert.deepEqual(media, []);
});

test('partition: the same note quoted twice is one card', () => {
  const { quotes } = partitionContent(
    `nostr:${NOTE_REF} and again nostr:${NOTE_REF}`,
  );
  assert.equal(quotes.length, 1);
});

test('partition: an undecodable reference stays in the text', () => {
  // It renders as itself rather than becoming a card that can never load.
  const { segments, quotes } = partitionContent('see nostr:note1broken ok');
  assert.equal(quotes.length, 0);
  assert.ok(
    segments.some((s) => s.kind === 'event' && s.eventId === null),
    'still a segment, so nothing silently vanishes',
  );
});

test('partition: a post that is only a quote has no text left', () => {
  const { segments, quotes } = partitionContent(`nostr:${NOTE_REF}`);
  assert.deepEqual(segments, []);
  assert.equal(quotes.length, 1);
});

test('partition: an nevent keeps the relays it names', () => {
  // An event that lives only on the hinted relay cannot be fetched from the
  // configured list. Dropping the hint was a P1 in review, and rightly.
  const { quotes } = partitionContent(`see nostr:${NEVENT_REF}`);
  assert.equal(quotes.length, 1);
  assert.deepEqual(quotes[0]?.relays, ['wss://hinted.example']);
});

test('partition: a hint that is not a relay URL is dropped', () => {
  // The hint is a string the author chose, and it is about to be connected to.
  const segments = parseContentSegments(`nostr:${NEVENT_BAD_HINT}`);
  const quoted = segments.find((s) => s.kind === 'event');
  assert.ok(quoted && quoted.kind === 'event');
  assert.deepEqual(quoted.relays, []);
});

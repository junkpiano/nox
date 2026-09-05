import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseContentSegments,
  partitionContent,
} from '../src/common/content-segments.js';
import { readEmojiTags } from '../src/common/custom-emoji.js';

const PIC = 'https://cdn.example/nox.png';

test('custom emoji: an emoji tag is a shortcode and a picture', () => {
  const emoji = readEmojiTags([
    ['emoji', 'nox', PIC],
    ['emoji', 'Shout', 'https://cdn.example/shout.gif'],
    ['e', 'not an emoji'],
  ]);
  assert.equal(emoji.get('nox'), PIC);
  // Keyed lowercase: the NIP says shortcodes are matched as written, but
  // the web app has always matched them case-insensitively and a reader
  // typing :Nox: for :nox: is not making a different request.
  assert.equal(emoji.get('shout'), 'https://cdn.example/shout.gif');
  assert.equal(emoji.size, 2);
});

test('custom emoji: a shortcode outside the alphabet, or a picture that is not one, is dropped', () => {
  const emoji = readEmojiTags([
    ['emoji', 'has space', PIC],
    ['emoji', 'colon:inside', PIC],
    ['emoji', '', PIC],
    ['emoji', 'script', 'javascript:alert(1)'],
    ['emoji', 'tor', 'https://x.onion/a.png'],
    ['emoji', 'missing'],
  ]);
  assert.equal(emoji.size, 0);
});

test('custom emoji: a plain http picture is refused where the platform refuses it', () => {
  const tags = [['emoji', 'plain', 'http://cdn.example/a.png']];
  assert.equal(readEmojiTags(tags).size, 1);
  assert.equal(readEmojiTags(tags, { secureOnly: true }).size, 0);
});

test('custom emoji: the later tag wins for the same shortcode', () => {
  const emoji = readEmojiTags([
    ['emoji', 'nox', 'https://cdn.example/old.png'],
    ['emoji', 'nox', PIC],
  ]);
  assert.equal(emoji.get('nox'), PIC);
});

test('segments: a shortcode with a picture becomes an emoji segment, and the text still rebuilds', () => {
  const emoji = new Map([['nox', PIC]]);
  const content = 'hello :nox: world :nope: and :NOX:';
  const segments = parseContentSegments(content, emoji);
  assert.deepEqual(segments, [
    { kind: 'text', text: 'hello ' },
    { kind: 'emoji', text: ':nox:', shortcode: 'nox', url: PIC },
    { kind: 'text', text: ' world :nope: and ' },
    { kind: 'emoji', text: ':NOX:', shortcode: 'NOX', url: PIC },
  ]);
  assert.equal(segments.map((s) => s.text).join(''), content);
});

test('segments: an unknown shortcode does not hide the known one after it', () => {
  const emoji = new Map([['b', PIC]]);
  const segments = parseContentSegments(':a:b:', emoji);
  assert.deepEqual(segments, [
    { kind: 'text', text: ':a' },
    { kind: 'emoji', text: ':b:', shortcode: 'b', url: PIC },
  ]);
});

test('segments: a shortcode inside a URL belongs to the URL', () => {
  const emoji = new Map([['nox', PIC]]);
  const segments = parseContentSegments('see https://a.example/:nox:/x', emoji);
  assert.equal(segments.filter((s) => s.kind === 'emoji').length, 0);
  assert.equal(segments[1]?.kind, 'url');
});

test('segments: no emoji tags means no emoji segments, whatever the text says', () => {
  assert.deepEqual(parseContentSegments('hi :nox:'), [
    { kind: 'text', text: 'hi :nox:' },
  ]);
  assert.deepEqual(parseContentSegments('hi :nox:', new Map()), [
    { kind: 'text', text: 'hi :nox:' },
  ]);
});

test('partition: emoji stay in the prose, next to the words', () => {
  const emoji = new Map([['nox', PIC]]);
  const { segments, media } = partitionContent(
    ':nox: look https://a.example/p.jpg',
    emoji,
  );
  assert.equal(segments[0]?.kind, 'emoji');
  assert.equal(media.length, 1);
});

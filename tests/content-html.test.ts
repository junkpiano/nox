/**
 * The card's text, drawn from the shared parser's segments.
 *
 * What matters: the hostile cases are inert, each kind of part becomes the
 * element it should, and the lists a card needs - pictures, links, mentions,
 * quotes - come out alongside the markup.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { nip19 } from 'nostr-tools';

import {
  renderContentHtml,
  renderEmojiHtml,
} from '../src/common/content-html.js';

const NPUB: string =
  'npub1paptfd5xjegzpnkzexxpw3npsaaw30pah8fyyuhyfz4mhv2ywcmsn5tp2u';
const NOTE: string = nip19.noteEncode('a'.repeat(64));

test('markup in a post is text, not markup', () => {
  const { html } = renderContentHtml('<img src=x onerror=alert(1)> & "x"', []);
  assert.ok(!html.includes('<img'));
  assert.ok(
    html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;x&quot;'),
  );
});

test('a picture is an <img> and is listed for the gallery; a link is a link', () => {
  const { html, images, links } = renderContentHtml(
    'see https://example.com/a.png and https://example.com/page',
    [],
  );
  assert.deepEqual(images, ['https://example.com/a.png']);
  assert.deepEqual(links, ['https://example.com/page']);
  assert.ok(html.includes('data-image-index="0"'));
  assert.ok(html.includes('<a href="https://example.com/page"'));
});

test('in energy saving mode a picture is a link to itself', () => {
  const { html, images } = renderContentHtml('https://example.com/a.png', [], {
    energySaving: true,
  });
  assert.deepEqual(images, []);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('a.png'));
});

test('a mention is a link to the person, and is listed for its name', () => {
  const { html, mentions } = renderContentHtml(`hi nostr:${NPUB}`, []);
  assert.ok(html.includes(`href="/${NPUB}"`));
  assert.ok(html.includes(`data-mention-npub="${NPUB}"`));
  assert.equal(mentions.get(NPUB)?.length, 64);
});

test('a quote leaves the text and is listed for its card; inline, it stays text', () => {
  const quoted = renderContentHtml(`look nostr:${NOTE}`, []);
  assert.deepEqual(quoted.quotes, [NOTE]);
  assert.ok(!quoted.html.includes(NOTE));
  const inline = renderContentHtml(`look nostr:${NOTE}`, [], { inline: true });
  assert.deepEqual(inline.quotes, []);
  assert.ok(inline.html.includes(NOTE));
});

test('a custom emoji with a tag is a picture; a line keeps only that', () => {
  const tags: string[][] = [['emoji', 'wave', 'https://example.com/wave.png']];
  assert.ok(
    renderContentHtml(':wave: hi :nope:', tags).html.includes('alt=":wave:"'),
  );
  const line: string = renderEmojiHtml(
    ':wave: https://example.com/x.png',
    tags,
  );
  assert.ok(line.includes('alt=":wave:"'));
  assert.ok(!line.includes('<a '));
});

test('an emoji URL cannot climb out of its attribute', () => {
  const tags: string[][] = [
    ['emoji', 'x', 'https://example.com/a.png" onerror="alert(1)'],
  ];
  const { html } = renderContentHtml(':x:', tags);
  assert.ok(!html.includes('onerror="alert'));
});

test('a reference inside a URL stays part of that URL', () => {
  const { html, links, mentions } = renderContentHtml(
    `https://example.com/?q=nostr:${NPUB}`,
    [],
  );
  assert.deepEqual(links, [`https://example.com/?q=nostr:${NPUB}`]);
  assert.equal(mentions.size, 0);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, parseOgpDocument } from '../src/common/ogp-parse.js';

const PAGE = 'https://example.com/articles/one';

test('ogp: property and name tags, in any attribute order and either quote', () => {
  const html = `<html><head>
    <meta property="og:title" content="Hello &amp; welcome">
    <meta content='A short description' name="description" />
    <META PROPERTY="og:site_name" CONTENT="Example">
    <meta name=twitter:card content=summary>
  </head><body></body></html>`;
  const data = parseOgpDocument(html, PAGE);
  assert.equal(data['og:title'], 'Hello & welcome');
  assert.equal(data.description, 'A short description');
  assert.equal(data['og:site_name'], 'Example');
  assert.equal(data['twitter:card'], 'summary');
});

test('ogp: image urls are resolved against the page, others left alone', () => {
  const html = `<meta property="og:image" content="/img/cover.jpg">
    <meta property="og:url" content="../canonical">
    <meta property="twitter:image" content="https://cdn.example.net/t.png">
    <meta name="author" content="/not-a-url">`;
  const data = parseOgpDocument(html, PAGE);
  assert.equal(data['og:image'], 'https://example.com/img/cover.jpg');
  assert.equal(data['og:url'], 'https://example.com/canonical');
  assert.equal(data['twitter:image'], 'https://cdn.example.net/t.png');
  assert.equal(data.author, '/not-a-url');
});

test('ogp: the first of duplicate tags wins, empty ones are skipped', () => {
  const html = `<meta property="og:title" content="">
    <meta property="og:title" content="First">
    <meta property="og:title" content="Second">`;
  assert.equal(parseOgpDocument(html, PAGE)['og:title'], 'First');
});

test('ogp: the <title> element stands in for a missing title, whitespace collapsed', () => {
  const html = `<html><head><title>
      Page   &#8212; Site
  </title></head></html>`;
  assert.equal(parseOgpDocument(html, PAGE).title, 'Page — Site');
  const withMeta = `<meta name="title" content="Meta title"><title>Element</title>`;
  assert.equal(parseOgpDocument(withMeta, PAGE).title, 'Meta title');
});

test('ogp: a page with nothing usable is empty', () => {
  assert.deepEqual(parseOgpDocument('<html><body>hi</body></html>', PAGE), {});
  assert.deepEqual(parseOgpDocument('', PAGE), {});
});

test('ogp: entities named, decimal and hex', () => {
  assert.equal(
    decodeEntities(
      'a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600; &unknown;',
    ),
    'a & b <c> "d" \'e\' 😀 &unknown;',
  );
});

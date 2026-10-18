/**
 * The small Markdown renderer behind the two legal pages: headings, lists,
 * tables, paragraphs and inline bold, code and links - and nothing it is
 * handed reaches the page unescaped.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/features/legal/render-markdown.js';

test('headings of each level get their own size, and deeper ones are not headings', () => {
  const html: string = renderMarkdown(
    '# One\n## Two\n### Three\n#### Four\n##### Five',
  );
  assert.match(html, /<h1 class="mt-2 mb-4 text-2xl font-semibold">One<\/h1>/);
  assert.match(html, /<h2 class="[^"]+">Two<\/h2>/);
  assert.match(html, /<h3 class="[^"]+">Three<\/h3>/);
  assert.match(html, /<h4 class="[^"]+">Four<\/h4>/);
  assert.match(html, /<p class="mb-3">##### Five<\/p>/);
});

test('consecutive lines join into one paragraph, and a blank line starts another', () => {
  assert.equal(
    renderMarkdown('first line\nsecond line\n\nthird'),
    '<p class="mb-3">first line second line</p>\n<p class="mb-3">third</p>',
  );
});

test('dash and star bullets make one list, ended by a paragraph', () => {
  assert.equal(
    renderMarkdown('- one\n* two\nafter'),
    '<ul class="mb-3 list-disc space-y-1 pl-5"><li>one</li><li>two</li></ul>\n<p class="mb-3">after</p>',
  );
});

test('a table has a header row, body rows, no alignment row, and scrolls on its own', () => {
  const html: string = renderMarkdown(
    '| Name | Kept |\n|---|:--:|\n| key | **never** |',
  );
  assert.match(
    html,
    /^<div class="mb-3 overflow-x-auto"><table class="w-full text-sm">/,
  );
  assert.match(
    html,
    /<th class="[^"]+">Name<\/th><th class="[^"]+">Kept<\/th>/,
  );
  assert.match(
    html,
    /<td class="[^"]+">key<\/td><td class="[^"]+"><strong>never<\/strong><\/td>/,
  );
  assert.doesNotMatch(html, /---/);
});

test('a list or paragraph right after a table closes the table first', () => {
  const html: string = renderMarkdown('| a |\n- item\n| b |\ntext');
  assert.equal(html.match(/<table/g)?.length, 2);
  assert.match(html, /<\/table><\/div>\n<ul/);
  assert.match(html, /<\/table><\/div>\n<p/);
});

test('inline code, bold and links are rendered, and links open in a new tab', () => {
  assert.equal(
    renderMarkdown(
      'Use `nsec` and **care**, see [docs](https://nox.garden/a?b=1&c=2).',
    ),
    '<p class="mb-3">Use <code class="rounded bg-white/10 px-1 text-xs">nsec</code> and <strong>care</strong>, see <a href="https://nox.garden/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer" class="underline">docs</a>.</p>',
  );
});

test('HTML in the source is escaped, attributes included', () => {
  const html: string = renderMarkdown(
    '<script>alert("x")</script> [a](x" onclick="y)',
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.match(html, /href="x&quot; onclick=&quot;y"/);
});

test('empty input renders nothing, and trailing spaces do not count', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   \n\n'), '');
  assert.equal(renderMarkdown('word   '), '<p class="mb-3">word</p>');
});

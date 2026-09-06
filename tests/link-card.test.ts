import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContentSegments } from '../src/common/content-segments.js';
import { cardWorthyUrls, describeLink } from '../src/common/link-card.js';

test('link card: the Open Graph tags win, the plain ones stand in', () => {
  assert.deepEqual(
    describeLink({
      url: 'https://www.example.com/post',
      data: {
        'og:title': ' An  article ',
        title: 'Page title',
        'og:description': 'What it\nsays',
        'og:image': 'https://cdn.example.com/a.jpg',
        'og:site_name': 'Example Daily',
      },
    }),
    {
      url: 'https://www.example.com/post',
      title: 'An article',
      description: 'What it says',
      image: 'https://cdn.example.com/a.jpg',
      site: 'Example Daily',
    },
  );
  assert.deepEqual(
    describeLink({
      url: 'https://www.example.com/post',
      data: {
        title: 'Page title',
        description: 'd',
        'twitter:image': '/rel.png',
      },
    }),
    {
      url: 'https://www.example.com/post',
      title: 'Page title',
      description: 'd',
      image: null,
      site: 'example.com',
    },
  );
});

test('link card: a page that says nothing gets no card, and only http(s) is a card', () => {
  assert.equal(describeLink({ url: 'https://example.com/', data: {} }), null);
  assert.equal(
    describeLink({ url: 'javascript:alert(1)', data: { title: 'x' } }),
    null,
  );
  assert.equal(
    describeLink({
      url: 'https://example.com/',
      data: { title: 'T', 'og:image': 'javascript:alert(1)' },
    })?.image,
    null,
  );
});

test('link card: web links in a post, not pictures, not twice, two at most', () => {
  const segments = parseContentSegments(
    'see https://a.example/one and https://a.example/one again, ' +
      'a picture https://a.example/p.jpg, https://b.example/two and https://c.example/three',
  );
  assert.deepEqual(cardWorthyUrls(segments), [
    'https://a.example/one',
    'https://b.example/two',
  ]);
  assert.deepEqual(cardWorthyUrls(segments, 3), [
    'https://a.example/one',
    'https://b.example/two',
    'https://c.example/three',
  ]);
});

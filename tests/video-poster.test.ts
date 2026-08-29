/**
 * Asking the browser to paint a frame instead of a black rectangle.
 *
 * A video with `preload="metadata"` fetches enough to know its duration and
 * nothing more, so it renders as a black box until someone presses play - you
 * cannot tell what you are about to watch. A `#t=` media fragment tells the
 * browser to seek there and show that frame, which costs one more range
 * request rather than the file.
 *
 * The obvious alternative was the thumbnail NIP-92 allows in an `imeta` tag.
 * Of eight video posts sampled off live relays, three carried an `imeta` tag
 * and none carried a thumbnail, so that path is not worth a branch yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { withPosterFrame } from '../src/common/media-type.js';

test('a video URL asks for its first frame', () => {
  assert.equal(
    withPosterFrame('https://example.com/a.mp4'),
    'https://example.com/a.mp4#t=0.1',
  );
});

test('a query string is kept, and the fragment goes after it', () => {
  // Media hosts sign URLs. Dropping the query would break the request; putting
  // the fragment before it would make the query part of the fragment.
  assert.equal(
    withPosterFrame('https://example.com/a.mp4?sig=abc'),
    'https://example.com/a.mp4?sig=abc#t=0.1',
  );
});

test('a URL that already carries a fragment is left alone', () => {
  // Someone linking to a moment in a video means that moment, and a second
  // `#` would not parse anyway.
  assert.equal(
    withPosterFrame('https://example.com/a.mp4#t=30'),
    'https://example.com/a.mp4#t=30',
  );
  assert.equal(
    withPosterFrame('https://example.com/a.mp4#anything'),
    'https://example.com/a.mp4#anything',
  );
});

test('an empty fragment is replaced rather than doubled', () => {
  assert.equal(
    withPosterFrame('https://example.com/a.mp4#'),
    'https://example.com/a.mp4#t=0.1',
  );
});

test('the URL from the report gets a poster frame', () => {
  assert.equal(
    withPosterFrame(
      'https://media.21media.to/10eec25ff99b48e913d95fa8c7f1e814c35e125fcd232837788f644730959950.mp4',
    ),
    'https://media.21media.to/10eec25ff99b48e913d95fa8c7f1e814c35e125fcd232837788f644730959950.mp4#t=0.1',
  );
});

/**
 * Telling an image from a video before deciding how to render it.
 *
 * These were one branch, so a video went into an <img>. A browser cannot
 * decode one there, but it downloads the whole file before finding that out -
 * twenty megabytes for the post that prompted this - and the gallery then
 * fetched it a second time into another <img> on tap.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMediaUrl } from '../src/common/media-type.js';

test('still images are images', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']) {
    assert.equal(
      classifyMediaUrl(`https://example.com/a.${ext}`),
      'image',
      `.${ext} should be an image`,
    );
  }
});

test('videos are videos', () => {
  for (const ext of ['mp4', 'webm', 'mov', 'avi']) {
    assert.equal(
      classifyMediaUrl(`https://example.com/a.${ext}`),
      'video',
      `.${ext} should be a video`,
    );
  }
});

test('the extension is matched whatever its case', () => {
  assert.equal(classifyMediaUrl('https://example.com/a.MP4'), 'video');
  assert.equal(classifyMediaUrl('https://example.com/a.PNG'), 'image');
});

test('anything else is not media', () => {
  assert.equal(classifyMediaUrl('https://example.com/article'), null);
  assert.equal(classifyMediaUrl('https://example.com/a.pdf'), null);
  assert.equal(classifyMediaUrl('https://example.com/'), null);
});

test('a query string does not hide the extension', () => {
  // Media hosts sign URLs. Reading the extension off the raw string missed
  // those, so a signed image fell through to being a bare link.
  assert.equal(classifyMediaUrl('https://example.com/a.mp4?x=1'), 'video');
  assert.equal(classifyMediaUrl('https://example.com/a.png?v=2#top'), 'image');
});

test('an extension in the host or a directory is not the file type', () => {
  assert.equal(classifyMediaUrl('https://mp4.example.com/article'), null);
  assert.equal(classifyMediaUrl('https://example.com/png/article'), null);
});

test('the real post that started this is a video', () => {
  assert.equal(
    classifyMediaUrl(
      'https://media.21media.to/10eec25ff99b48e913d95fa8c7f1e814c35e125fcd232837788f644730959950.mp4',
    ),
    'video',
  );
});

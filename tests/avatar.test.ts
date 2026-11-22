import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  avatarFallbackAttribute,
  avatarUrlFor,
  fallbackAvatarUrl,
  loadableImageUrl,
} from '../src/common/avatar.js';
import { handleImageError } from '../src/common/avatar-dom.js';

const PUBKEY = 'a'.repeat(64);
const secure = { secureOnly: true };
const anywhere = { secureOnly: false };

test('avatar: pictures that can be shown are shown as they are', () => {
  assert.equal(
    loadableImageUrl('https://cdn.example/me.jpg', secure),
    'https://cdn.example/me.jpg',
  );
  assert.equal(
    loadableImageUrl('  https://cdn.example/me.jpg  ', secure),
    'https://cdn.example/me.jpg',
  );
  assert.equal(
    loadableImageUrl('data:image/png;base64,AAAA', secure),
    'data:image/png;base64,AAAA',
  );
  assert.equal(
    loadableImageUrl('blob:https://nox.garden/x', secure),
    'blob:https://nox.garden/x',
  );
});

test('avatar: an .onion picture needs Tor and is never asked for', () => {
  for (const url of [
    'http://fs26abcdefghijkl.onion/me.jpg',
    'https://something.onion/me.jpg',
    'https://ONION/x.png',
  ]) {
    assert.equal(loadableImageUrl(url, anywhere), null, url);
  }
});

test('avatar: a plain http picture is refused on a secure page and allowed elsewhere', () => {
  assert.equal(loadableImageUrl('http://cdn.example/me.jpg', secure), null);
  assert.equal(
    loadableImageUrl('http://cdn.example/me.jpg', anywhere),
    'http://cdn.example/me.jpg',
  );
});

test('avatar: things that are not pictures', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>',
    'ftp://cdn.example/me.jpg',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(loadableImageUrl(url, anywhere), null, String(url));
  }
});

test('avatar: the stand-in is the pubkey robot, and the person gets it when theirs cannot load', () => {
  assert.equal(fallbackAvatarUrl(PUBKEY), `https://robohash.org/${PUBKEY}.png`);
  assert.equal(
    avatarUrlFor(PUBKEY, { picture: 'http://fs26.onion/me.jpg' }, secure),
    fallbackAvatarUrl(PUBKEY),
  );
  assert.equal(avatarUrlFor(PUBKEY, null, secure), fallbackAvatarUrl(PUBKEY));
  assert.equal(
    avatarUrlFor(PUBKEY, { picture: 'https://cdn.example/me.jpg' }, secure),
    'https://cdn.example/me.jpg',
  );
});

test('avatar: the fallback attribute is a data attribute safe in HTML', () => {
  const attribute = avatarFallbackAttribute(PUBKEY);
  assert.equal(attribute, `data-fallback-src="${fallbackAvatarUrl(PUBKEY)}"`);
  assert.ok(!fallbackAvatarUrl(PUBKEY).includes('"'));
});

function failedImage(dataset: Record<string, string>): {
  tagName: string;
  src: string;
  dataset: Record<string, string | undefined>;
  parentElement: { classList: { add(name: string): void } };
  parentClasses: string[];
  removed: boolean;
  remove(): void;
} {
  const parentClasses: string[] = [];
  const img = {
    tagName: 'IMG',
    src: 'https://cdn.example/broken.jpg',
    dataset: { ...dataset } as Record<string, string | undefined>,
    parentElement: {
      classList: { add: (name: string): number => parentClasses.push(name) },
    },
    parentClasses,
    removed: false,
    remove(): void {
      img.removed = true;
    },
  };
  return img;
}

test('avatar: a failed picture swaps to its stand-in once, then stays failed', () => {
  const img = failedImage({ fallbackSrc: fallbackAvatarUrl(PUBKEY) });
  handleImageError({ target: img });
  assert.equal(img.src, fallbackAvatarUrl(PUBKEY));
  assert.equal(img.dataset.fallbackSrc, undefined);
  img.src = 'still-broken';
  handleImageError({ target: img });
  assert.equal(img.src, 'still-broken');
  assert.equal(img.removed, false);
});

test('avatar: a failed banner marks its parent and is removed', () => {
  const img = failedImage({ errorParentClass: 'nox-profile-banner-blank' });
  handleImageError({ target: img });
  assert.deepEqual(img.parentClasses, ['nox-profile-banner-blank']);
  assert.equal(img.removed, true);
});

test('avatar: a stand-in that fails is not requested again', () => {
  const img = failedImage({ fallbackSrc: fallbackAvatarUrl(PUBKEY) });
  img.src = fallbackAvatarUrl(PUBKEY);
  let sets = 0;
  Object.defineProperty(img, 'src', {
    get: (): string => fallbackAvatarUrl(PUBKEY),
    set: (): void => {
      sets++;
    },
  });
  handleImageError({ target: img });
  assert.equal(sets, 0);
  assert.equal(img.dataset.fallbackSrc, undefined);
});

test('avatar: errors from anything but an image, or an image without a fallback, are left alone', () => {
  const script = { ...failedImage({ fallbackSrc: 'x' }), tagName: 'SCRIPT' };
  handleImageError({ target: script });
  assert.equal(script.src, 'https://cdn.example/broken.jpg');
  const plain = failedImage({});
  handleImageError({ target: plain });
  assert.equal(plain.removed, false);
  handleImageError({ target: null });
});

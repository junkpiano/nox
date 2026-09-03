import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  avatarErrorAttribute,
  avatarUrlFor,
  fallbackAvatarUrl,
  loadableImageUrl,
} from '../src/common/avatar.js';

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

test('avatar: the failure handler disarms itself before swapping', () => {
  const attribute = avatarErrorAttribute(PUBKEY);
  assert.ok(attribute.startsWith('this.onerror=null;'), attribute);
  assert.ok(attribute.includes(fallbackAvatarUrl(PUBKEY)));
  assert.ok(
    !attribute.includes('"'),
    'must be safe inside a double-quoted attribute',
  );
});

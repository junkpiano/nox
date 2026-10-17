/**
 * Someone's custom emoji: the NIP-51 list's own emoji, then each set it
 * names, each shortcode once - and adding one rewrites the list without
 * losing anything already in it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { addToEmojiList, fetchEmojiList } from '../src/common/emoji-list.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import type { PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

const kv: Map<string, string> = memoryKv();
const me: Uint8Array = generateSecretKey();
const ME: PubkeyHex = getPublicKey(me) as PubkeyHex;
const maker: Uint8Array = generateSecretKey();
const MAKER: string = getPublicKey(maker);
setSessionPrivateKeyFromRaw(nip19.nsecEncode(me));

const img = (name: string): string => `https://example.com/${name}.png`;

test('no list on any relay is no custom emoji', async () => {
  fakeRelay('wss://empty.emoji');
  assert.deepEqual(await fetchEmojiList(ME, ['wss://empty.emoji']), []);
});

test('the list’s own emoji come first, then each set in order, each shortcode once', async () => {
  const list = signed(me, {
    kind: 10030,
    tags: [
      ['emoji', 'Wave', img('wave')],
      ['emoji', 'bad code!', img('bad')],
      ['emoji', 'nourl', 'javascript:alert(1)'],
      ['emoji', ''],
      ['a', `30030:${MAKER}:cats`],
      ['a', `30030:${MAKER}:`],
      ['a', `30030:${MAKER}`],
      ['a', `30031:${MAKER}:other`],
      ['a', '30030:not-a-pubkey:cats'],
    ],
  });
  const cats = signed(maker, {
    kind: 30030,
    created_at: 200,
    tags: [
      ['d', 'cats'],
      ['emoji', 'wave', img('cat-wave')],
      ['emoji', 'cat', img('cat')],
    ],
  });
  const oldCats = signed(maker, {
    kind: 30030,
    created_at: 100,
    tags: [
      ['d', 'cats'],
      ['emoji', 'oldcat', img('oldcat')],
    ],
  });
  const unnamed = signed(maker, {
    kind: 30030,
    tags: [
      ['d', ''],
      ['emoji', 'blank', img('blank')],
    ],
  });
  fakeRelay('wss://lists.emoji', { events: [list, cats, oldCats, unnamed] });
  assert.deepEqual(await fetchEmojiList(ME, ['wss://lists.emoji']), [
    { shortcode: 'Wave', url: img('wave') },
    { shortcode: 'cat', url: img('cat') },
    { shortcode: 'blank', url: img('blank') },
  ]);
});

test('adding needs every relay to have answered', async () => {
  kv.set('nostr_pubkey', ME);
  fakeRelay('wss://up.emoji');
  fakeRelay('wss://down.emoji', { refuses: true });
  await assert.rejects(
    addToEmojiList(ME, ['wss://up.emoji', 'wss://down.emoji'], {
      shortcode: 'x',
      url: img('x'),
    }),
    NoRelayAnsweredError,
  );
});

test('an emoji that fails the NIP-30 checks is not added', async () => {
  fakeRelay('wss://checks.emoji');
  await assert.rejects(
    addToEmojiList(ME, ['wss://checks.emoji'], {
      shortcode: 'x',
      url: 'javascript:alert(1)',
    }),
    /cannot be added/,
  );
});

test('an emoji is added to the whole list, once, and two adds at once both land', async () => {
  const list = signed(me, {
    kind: 10030,
    content: 'private entries',
    created_at: 100,
    tags: [
      ['emoji', 'wave', img('wave')],
      ['a', `30030:${MAKER}:cats`],
    ],
  });
  const relay = fakeRelay('wss://add.emoji', { events: [list] });
  assert.equal(
    await addToEmojiList(ME, ['wss://add.emoji'], {
      shortcode: 'WAVE',
      url: img('other'),
    }),
    'already',
  );
  const [first, second] = await Promise.all([
    addToEmojiList(ME, ['wss://add.emoji'], {
      shortcode: 'cat',
      url: img('cat'),
    }),
    addToEmojiList(ME, ['wss://add.emoji'], {
      shortcode: 'dog',
      url: img('dog'),
    }),
  ]);
  assert.equal(first, 'added');
  assert.equal(second, 'added');
  const last = relay.published[relay.published.length - 1];
  assert.ok(last);
  assert.equal(last.content, 'private entries');
  assert.deepEqual(last.tags, [
    ['emoji', 'wave', img('wave')],
    ['a', `30030:${MAKER}:cats`],
    ['emoji', 'cat', img('cat')],
    ['emoji', 'dog', img('dog')],
  ]);
});

test('a list read for one account is not signed by another', async () => {
  fakeRelay('wss://switch.emoji');
  kv.set('nostr_pubkey', 'f'.repeat(64));
  await assert.rejects(
    addToEmojiList(ME, ['wss://switch.emoji'], {
      shortcode: 'x',
      url: img('x'),
    }),
    /account changed/,
  );
  kv.set('nostr_pubkey', ME);
});

test('a list no relay accepted is an error', async () => {
  fakeRelay('wss://reject.emoji', { accepts: false });
  await assert.rejects(
    addToEmojiList(ME, ['wss://reject.emoji'], {
      shortcode: 'x',
      url: img('x'),
    }),
    /No relay accepted/,
  );
});

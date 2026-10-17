/**
 * The heart button's reaction: kept on the account as app data, copied to
 * the device, and only ever something a reaction can sensibly be.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  DEFAULT_QUICK_REACTION,
  getQuickReaction,
  refreshQuickReaction,
  setQuickReaction,
} from '../src/common/quick-reaction.js';
import { getReactionAggregate } from '../src/common/reaction-interactions.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import type { PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

const kv: Map<string, string> = memoryKv();
const key: Uint8Array = generateSecretKey();
const VIEWER: PubkeyHex = getPublicKey(key) as PubkeyHex;
setSessionPrivateKeyFromRaw(nip19.nsecEncode(key));
const LOCAL: string = `nostr_quick_reaction:${VIEWER}`;
const PARTY: string = 'https://example.com/party.png';

function choice(content: string, created_at: number, tags: string[][] = []) {
  return signed(key, {
    kind: 30078,
    content,
    created_at,
    tags: [['d', 'nox-reaction-emoji'], ...tags],
  });
}

test('until a choice is made the heart is a heart', () => {
  assert.equal(getQuickReaction(null), DEFAULT_QUICK_REACTION);
  assert.equal(getQuickReaction(VIEWER).content, '❤');
});

test('the account’s choice replaces the device’s, but not with an older one', async () => {
  kv.delete(LOCAL);
  fakeRelay('wss://fire.quick', { events: [choice('🔥', 200)] });
  assert.equal(
    (await refreshQuickReaction(VIEWER, ['wss://fire.quick'])).content,
    '🔥',
  );

  fakeRelay('wss://stale.quick', { events: [choice('👍', 100)] });
  assert.equal(
    (await refreshQuickReaction(VIEWER, ['wss://stale.quick'])).content,
    '🔥',
  );

  fakeRelay('wss://none.quick');
  assert.equal(
    (await refreshQuickReaction(VIEWER, ['wss://none.quick'])).content,
    '🔥',
  );
});

test('a custom emoji counts only with a usable picture, and a sentence is not a reaction', () => {
  const saved = (content: string, tags: string[][]): void => {
    kv.set(LOCAL, JSON.stringify({ content, tags }));
  };
  saved(':party:', [['emoji', 'party', PARTY]]);
  const party = getQuickReaction(VIEWER);
  assert.equal(party.shortcode, 'party');
  assert.equal(party.imageUrl, PARTY);

  saved(':party:', []);
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
  saved(':party:', [['emoji', 'party', 'javascript:alert(1)']]);
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
  saved('this is far too long to be one emoji', []);
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
  saved('   ', []);
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
  saved('👍', []);
  assert.equal(getQuickReaction(VIEWER).content, '👍');
});

test('a damaged device copy reads as the default', () => {
  kv.set(LOCAL, '{oops');
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
  kv.set(LOCAL, JSON.stringify({ content: 1, tags: [] }));
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
});

test('a new choice is published as app data after the last one and kept here', async () => {
  const future: number = Math.floor(Date.now() / 1000) + 1000;
  kv.set(
    LOCAL,
    JSON.stringify({ content: '👍', tags: [], created_at: future, id: 'x' }),
  );
  const relay = fakeRelay('wss://save.quick');
  const reaction = getReactionAggregate(':party:', [['emoji', 'party', PARTY]]);
  await setQuickReaction(VIEWER, ['wss://save.quick'], reaction);
  const sent = relay.published[0];
  assert.ok(sent);
  assert.equal(sent.kind, 30078);
  assert.equal(sent.content, ':party:');
  assert.deepEqual(sent.tags, [
    ['d', 'nox-reaction-emoji'],
    ['emoji', 'party', PARTY],
  ]);
  assert.equal(sent.created_at, future + 1);
  assert.equal(getQuickReaction(VIEWER).shortcode, 'party');
});

test('a choice no relay accepted is an error and is not kept', async () => {
  kv.delete(LOCAL);
  fakeRelay('wss://no.quick', { accepts: false });
  await assert.rejects(
    setQuickReaction(
      VIEWER,
      ['wss://no.quick'],
      getReactionAggregate('🔥', []),
    ),
    /No relay accepted/,
  );
  assert.equal(getQuickReaction(VIEWER), DEFAULT_QUICK_REACTION);
});

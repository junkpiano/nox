/**
 * The relay list: what the viewer configured, how healthy each relay has
 * been, and the NIP-65 event that tells others where to find them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { onAppEvent } from '../src/common/app-events.js';
import { kvGet, kvSet } from '../src/common/kv.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import {
  buildNip65RelayTags,
  fetchNip65RelayList,
  parseNip65RelayUrls,
  signNip65RelayListEvent,
} from '../src/features/relays/nip65.js';
import {
  didUserConfigureRelays,
  getAllRelays,
  getRelays,
  normalizeRelayUrl,
  recordRelayFailure,
  recordRelaySuccess,
  reloadRelays,
  setRelays,
} from '../src/features/relays/relays.js';
import type { NostrEvent } from '../types/nostr';
import {
  fakeRelays,
  installFakeWebSocket,
  storeRelay,
} from './fake-relay-store.js';

installFakeWebSocket();

const RELAYS_KEY: string = 'nostr_relays';
const HEALTH_KEY: string = 'nostr_relay_health_v1';
const health = (): Record<string, { success: number; failure: number }> =>
  JSON.parse(kvGet(HEALTH_KEY) ?? '{}');

test('relay URLs get a scheme, lose a bare trailing slash, and anything else is refused', () => {
  assert.equal(normalizeRelayUrl('relay.example'), 'wss://relay.example');
  assert.equal(
    normalizeRelayUrl('  wss://relay.example/  '),
    'wss://relay.example',
  );
  assert.equal(normalizeRelayUrl('ws://local:7777'), 'ws://local:7777');
  assert.equal(
    normalizeRelayUrl('wss://relay.example/path/'),
    'wss://relay.example/path/',
  );
  assert.equal(normalizeRelayUrl(''), null);
  assert.equal(normalizeRelayUrl('   '), null);
  assert.equal(normalizeRelayUrl('wss://exa mple'), null);
  assert.equal(normalizeRelayUrl('wss://[bad'), null);
});

test('a URL with another scheme is refused, not read as a host', () => {
  assert.equal(normalizeRelayUrl('https://relay.example'), null);
  assert.equal(normalizeRelayUrl('http://relay.example'), null);
  assert.equal(normalizeRelayUrl('localhost:7777'), 'wss://localhost:7777');
});

test('with nothing stored, the defaults are used and the user has configured nothing', () => {
  reloadRelays();
  assert.equal(didUserConfigureRelays(), false);
  assert.ok(getRelays().length > 0);
  assert.deepEqual(getAllRelays(), getRelays());
});

test('setting relays stores them once each and announces the change', () => {
  let announced: number = 0;
  const stop = onAppEvent('relays-updated', (): void => {
    announced += 1;
  });
  setRelays(['wss://a.example', 'wss://b.example', 'wss://a.example']);
  stop();
  assert.deepEqual(getRelays(), ['wss://a.example', 'wss://b.example']);
  assert.equal(kvGet(RELAYS_KEY), '["wss://a.example","wss://b.example"]');
  assert.equal(didUserConfigureRelays(), true);
  assert.equal(announced, 1);
});

test('health is counted only for configured relays, and forgotten when a relay is removed', () => {
  setRelays(['wss://a.example', 'wss://b.example']);
  recordRelaySuccess('wss://a.example/');
  recordRelaySuccess('wss://a.example');
  recordRelayFailure('a.example');
  recordRelayFailure('wss://b.example');
  recordRelayFailure('wss://stranger.example');
  assert.deepEqual(health(), {
    'wss://a.example': { success: 2, failure: 1 },
    'wss://b.example': { success: 0, failure: 1 },
  });
  setRelays(['wss://a.example']);
  assert.deepEqual(Object.keys(health()), ['wss://a.example']);
});

test('reloading reads the stored list again, normalised, and keeps health only for listed relays', () => {
  kvSet(
    RELAYS_KEY,
    JSON.stringify(['c.example', 42, 'wss://bad host', 'wss://c.example/']),
  );
  kvSet(
    HEALTH_KEY,
    JSON.stringify({
      'wss://c.example': { success: 3, failure: 'x' },
      'wss://gone.example': { success: 1, failure: 1 },
    }),
  );
  reloadRelays();
  assert.deepEqual(getRelays(), ['wss://c.example']);
  recordRelaySuccess('wss://c.example');
  assert.deepEqual(health(), { 'wss://c.example': { success: 4, failure: 0 } });
});

test('a stored list that is not a list, or holds nothing usable, falls back to the defaults', () => {
  reloadRelays();
  kvSet(RELAYS_KEY, '{"not":"a list"}');
  kvSet(HEALTH_KEY, 'not json');
  reloadRelays();
  const defaults: string[] = [...getRelays()];
  assert.ok(defaults.length > 0);
  kvSet(RELAYS_KEY, '["wss://bad host", 7]');
  reloadRelays();
  assert.deepEqual(getRelays(), defaults);
  kvSet(RELAYS_KEY, 'not json');
  reloadRelays();
  assert.deepEqual(getRelays(), defaults);
});

test('NIP-65 r tags are read normalised and once each, ignoring everything else', () => {
  assert.deepEqual(
    parseNip65RelayUrls([
      ['r', 'wss://a.example/'],
      ['r', 'a.example', 'read'],
      ['r', 'wss://b.example', 'write'],
      ['r'],
      ['r', 'wss://not a relay'],
      ['p', 'wss://c.example'],
    ]),
    ['wss://a.example', 'wss://b.example'],
  );
});

test('NIP-65 tags are built from valid URLs only', () => {
  assert.deepEqual(
    buildNip65RelayTags(['wss://a.example', 'wss://x y', 'b.example']),
    [
      ['r', 'wss://a.example'],
      ['r', 'wss://b.example'],
    ],
  );
});

test('two spellings of one relay produce one tag', () => {
  assert.deepEqual(
    buildNip65RelayTags(['wss://a.example/', 'wss://a.example', 'A.example']),
    [['r', 'wss://a.example']],
  );
});

test('a signed relay list carries the r tags and the signer as author', async () => {
  const key: Uint8Array = generateSecretKey();
  const pubkey: string = setSessionPrivateKeyFromRaw(
    Buffer.from(key).toString('hex'),
  );
  const event = await signNip65RelayListEvent({
    pubkeyHex: pubkey,
    relayUrls: ['wss://a.example'],
  });
  assert.equal(event.kind, 10002);
  assert.equal(event.pubkey, pubkey);
  assert.deepEqual(event.tags, [['r', 'wss://a.example']]);
  assert.equal(event.content, '');
});

test('the newest relay list on any relay is the one returned', async () => {
  const key: Uint8Array = generateSecretKey();
  const pubkey: string = getPublicKey(key);
  const list = (created_at: number, url: string): NostrEvent =>
    finalizeEvent(
      { kind: 10002, created_at, tags: [['r', url]], content: '' },
      key,
    ) as unknown as NostrEvent;
  fakeRelays.set(
    'wss://old.example',
    storeRelay([list(100, 'wss://x.example')]),
  );
  fakeRelays.set(
    'wss://new.example',
    storeRelay([list(200, 'wss://y.example/')]),
  );
  assert.deepEqual(
    await fetchNip65RelayList({
      pubkeyHex: pubkey,
      relays: ['wss://old.example', 'wss://new.example'],
    }),
    { relayUrls: ['wss://y.example'], createdAt: 200 },
  );
  fakeRelays.set('wss://empty.example', storeRelay([]));
  assert.equal(
    await fetchNip65RelayList({
      pubkeyHex: pubkey,
      relays: ['wss://empty.example'],
    }),
    null,
  );
});

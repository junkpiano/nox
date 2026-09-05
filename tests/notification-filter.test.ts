/**
 * Notifications from the people you follow.
 *
 * The list is the viewer's own kind 3, believed only when they signed it;
 * a relay that answers with nothing means they follow nobody, and no relay
 * answering means nothing was learned. The two must not look alike.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { type KvStore, setKvStore } from '../src/common/kv.js';
import {
  collectFollowSet,
  fetchFollowSet,
  fromFollowedAuthors,
  readNotificationScope,
  saveNotificationScope,
  scopeNotifications,
} from '../src/common/notification-filter.js';
import type { SubscriptionOpener } from '../src/common/relay-query.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const NOW: number = Math.floor(Date.now() / 1000);
const me = generateSecretKey();
const other = generateSecretKey();
const ME = getPublicKey(me) as PubkeyHex;
const FRIEND = 'f'.repeat(64) as PubkeyHex;
const STRANGER = '5'.repeat(64) as PubkeyHex;

function delivered(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function followList(
  key: Uint8Array,
  follows: PubkeyHex[],
  createdAt: number = NOW - 60,
): NostrEvent {
  return delivered(
    finalizeEvent(
      {
        kind: 3,
        created_at: createdAt,
        tags: follows.map((p: PubkeyHex): string[] => ['p', p]),
        content: '',
      },
      key,
    ) as NostrEvent,
  );
}

function reply(from: PubkeyHex, id: string): NostrEvent {
  return {
    id,
    pubkey: from,
    kind: 1,
    created_at: NOW,
    tags: [['p', ME]],
    content: 'hi',
    sig: '',
  } as NostrEvent;
}

function scripted(
  behaviour: Record<string, 'answer' | 'refuse'>,
  events: NostrEvent[] = [],
): SubscriptionOpener {
  return async (relayUrl, _filter, subscription) => {
    if (behaviour[relayUrl] === 'refuse') throw new Error('refused');
    queueMicrotask((): void => {
      for (const event of events) subscription.onEvent?.(event);
      subscription.onEose?.();
    });
    return (): void => {};
  };
}

test('following: only notifications from people on the list stay, in order', () => {
  const kept = fromFollowedAuthors(
    [reply(STRANGER, '1'), reply(FRIEND, '2'), reply(STRANGER, '3')],
    new Set([FRIEND]),
  );
  assert.deepEqual(
    kept.map((e) => e.id),
    ['2'],
  );
});

test("follow set: the viewer's own signed list, newest first", () => {
  const older = followList(me, [STRANGER], NOW - 600);
  const newer = followList(me, [FRIEND], NOW - 30);
  assert.deepEqual([...(collectFollowSet(ME, [older, newer]) ?? [])], [FRIEND]);
});

test("follow set: a list with the viewer's pubkey and somebody else's signature is not theirs", () => {
  const forged: NostrEvent = { ...followList(other, [STRANGER]), pubkey: ME };
  const real = followList(me, [FRIEND], NOW - 600);
  assert.deepEqual([...(collectFollowSet(ME, [forged, real]) ?? [])], [FRIEND]);
  // Somebody else's list is not the viewer's: no list at all.
  assert.equal(collectFollowSet(ME, [followList(other, [STRANGER])]), null);
});

test('follow set: no list is not an answer; an empty signed list is', () => {
  assert.equal(collectFollowSet(ME, []), null);
  assert.equal(collectFollowSet(ME, [followList(me, [])])?.size, 0);
});

test('follow set: silence from every relay is an error, not an empty list', async () => {
  await assert.rejects(
    fetchFollowSet(ME, ['wss://a'], scripted({ 'wss://a': 'refuse' })),
    NoRelayAnsweredError,
  );
  await assert.rejects(fetchFollowSet(ME, []), NoRelayAnsweredError);
  const none = await fetchFollowSet(
    ME,
    ['wss://a'],
    scripted({ 'wss://a': 'answer' }),
  );
  assert.equal(none, null);
});

test('scope: "all" asks nobody; "following" filters; nobody followed and nobody answering are told apart', async () => {
  const events = [reply(STRANGER, '1'), reply(FRIEND, '2')];
  const all = await scopeNotifications(
    'all',
    ME,
    events,
    ['wss://a'],
    scripted({ 'wss://a': 'refuse' }),
  );
  assert.deepEqual(all, { scope: 'all', events });

  const filtered = await scopeNotifications(
    'following',
    ME,
    events,
    ['wss://a'],
    scripted({ 'wss://a': 'answer' }, [followList(me, [FRIEND])]),
  );
  assert.equal(filtered.scope, 'following');
  assert.deepEqual(
    filtered.events.map((e) => e.id),
    ['2'],
  );
  assert.equal(filtered.scope === 'following' && filtered.followCount, 1);

  const nobody = await scopeNotifications(
    'following',
    ME,
    events,
    ['wss://a'],
    scripted({ 'wss://a': 'answer' }, [followList(me, [])]),
  );
  assert.equal(nobody.scope, 'following');
  assert.equal(nobody.events.length, 0);
  assert.equal(nobody.scope === 'following' && nobody.followCount, 0);

  // Answered, but without the list: the filter cannot be applied.
  const missing = await scopeNotifications(
    'following',
    ME,
    events,
    ['wss://a'],
    scripted({ 'wss://a': 'answer' }),
  );
  assert.equal(missing.scope, 'following-unavailable');
  assert.equal(missing.events.length, 2);

  const failed = await scopeNotifications(
    'following',
    ME,
    events,
    ['wss://a'],
    scripted({ 'wss://a': 'refuse' }),
  );
  assert.equal(failed.scope, 'following-unavailable');
  assert.equal(failed.events.length, 2);
});

test('scope: the choice is remembered on this device, and defaults to all', () => {
  const held: Map<string, string> = new Map();
  const store: KvStore = {
    get: (k) => held.get(k) ?? null,
    set: (k, v) => {
      held.set(k, v);
    },
    remove: (k) => {
      held.delete(k);
    },
  };
  setKvStore(store);
  assert.equal(readNotificationScope(), 'all');
  saveNotificationScope('following');
  assert.equal(readNotificationScope(), 'following');
  held.set('notifications_scope', 'garbage');
  assert.equal(readNotificationScope(), 'all');
});

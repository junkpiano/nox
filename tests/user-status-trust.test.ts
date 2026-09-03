/**
 * What a relay sends about someone's status is believed only when it is
 * theirs.
 *
 * The fixtures are really signed, so a forgery here is a real forgery: the
 * right pubkey with somebody else's signature, or a genuine event from a
 * person nobody asked about. And silence from every relay is told apart
 * from every relay saying "no status": the first is an error, the second an
 * answer somebody may remember.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { SubscriptionOpener } from '../src/common/relay-query.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import {
  collectUserStatuses,
  fetchUserStatuses,
} from '../src/features/profile/user-status.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const NOW: number = Math.floor(Date.now() / 1000);
const alice = generateSecretKey();
const mallory = generateSecretKey();
const ALICE = getPublicKey(alice) as PubkeyHex;

/**
 * As a relay would deliver it. `finalizeEvent` marks the object it signed
 * as verified, and a spread copies that mark, so a forgery built by
 * spreading would pass `verifyEvent` untested. A round trip through JSON
 * is what the real thing goes through, and drops the mark.
 */
function delivered(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function status(
  key: Uint8Array,
  text: string,
  createdAt: number = NOW - 60,
): NostrEvent {
  return delivered(
    finalizeEvent(
      {
        kind: 30315,
        created_at: createdAt,
        tags: [['d', 'general']],
        content: text,
      },
      key,
    ) as NostrEvent,
  );
}

test("status trust: a status is believed only with its author's own signature", () => {
  const genuine = status(alice, 'at the beach');
  // Mallory's signature under Alice's pubkey: the id and sig are Mallory's,
  // the pubkey field is not.
  const forged: NostrEvent = {
    ...status(mallory, 'gone forever'),
    pubkey: ALICE,
  };
  const found = collectUserStatuses([ALICE], [forged, genuine], NOW);
  assert.equal(found.get(ALICE)?.text, 'at the beach');
});

test('status trust: a forgery newer than the real one does not win', () => {
  const genuine = status(alice, 'at the beach', NOW - 120);
  const forged: NostrEvent = {
    ...status(mallory, 'gone forever', NOW - 10),
    pubkey: ALICE,
  };
  const found = collectUserStatuses([ALICE], [genuine, forged], NOW);
  assert.equal(found.get(ALICE)?.text, 'at the beach');
});

test('status trust: a genuine status from someone nobody asked about is not kept', () => {
  const found = collectUserStatuses([ALICE], [status(mallory, 'hello')], NOW);
  assert.equal(found.size, 0);
});

test('status trust: the newest genuine one per person wins', () => {
  const found = collectUserStatuses(
    [ALICE],
    [status(alice, 'old', NOW - 600), status(alice, 'new', NOW - 30)],
    NOW,
  );
  assert.equal(found.get(ALICE)?.text, 'new');
});

test('status trust: two revisions in the same second resolve by id, whichever arrived first', () => {
  // NIP-01: for an addressable event, the same second is broken by the
  // lexically smaller id. So every client reading these two agrees, and
  // the answer does not depend on which relay was quicker.
  const first = status(alice, 'first', NOW - 30);
  const second = status(alice, 'second', NOW - 30);
  const [smaller, larger] = [first, second].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  const oneWay = collectUserStatuses([ALICE], [first, second], NOW);
  const otherWay = collectUserStatuses([ALICE], [second, first], NOW);
  assert.equal(oneWay.get(ALICE)?.text, smaller?.content);
  assert.equal(otherWay.get(ALICE)?.text, smaller?.content);
  assert.notEqual(oneWay.get(ALICE)?.text, larger?.content);
});

/** Relays that behave as scripted. */
function scripted(
  behaviour: Record<string, 'answer' | 'refuse' | 'silent'>,
  events: NostrEvent[] = [],
): SubscriptionOpener {
  return async (relayUrl, _filter, subscription) => {
    const what = behaviour[relayUrl] ?? 'silent';
    if (what === 'refuse') throw new Error(`refused by ${relayUrl}`);
    queueMicrotask((): void => {
      if (what === 'answer') {
        for (const event of events) subscription.onEvent?.(event);
        subscription.onEose?.();
      }
    });
    return (): void => {};
  };
}

test('status trust: every relay failing is an error, not "no status"', async () => {
  await assert.rejects(
    fetchUserStatuses(
      { pubkeys: [ALICE], relays: ['wss://a', 'wss://b'] },
      scripted({ 'wss://a': 'refuse', 'wss://b': 'refuse' }),
    ),
    NoRelayAnsweredError,
  );
  await assert.rejects(
    fetchUserStatuses({ pubkeys: [ALICE], relays: [] }),
    NoRelayAnsweredError,
  );
});

test('status trust: a relay that answered with nothing is an answer', async () => {
  const found = await fetchUserStatuses(
    { pubkeys: [ALICE], relays: ['wss://a', 'wss://b'] },
    scripted({ 'wss://a': 'answer', 'wss://b': 'refuse' }),
  );
  assert.equal(found.size, 0);
});

test('status trust: what a relay sends is filtered the same way', async () => {
  const forged: NostrEvent = { ...status(mallory, 'forged'), pubkey: ALICE };
  const found = await fetchUserStatuses(
    { pubkeys: [ALICE], relays: ['wss://a'] },
    scripted({ 'wss://a': 'answer' }, [
      forged,
      status(alice, 'real'),
      status(mallory, 'uninvited'),
    ]),
  );
  assert.deepEqual(
    Array.from(found.entries()).map(([who, s]) => [who, s.text]),
    [[ALICE, 'real']],
  );
});

test('status trust: nobody to ask about asks nobody', async () => {
  let opened = 0;
  const found = await fetchUserStatuses(
    { pubkeys: [], relays: ['wss://a'] },
    async () => {
      opened += 1;
      return (): void => {};
    },
  );
  assert.equal(found.size, 0);
  assert.equal(opened, 0);
});

/**
 * An empty answer and no answer are different things.
 *
 * Every relay timing out, refusing the connection or closing it produces the
 * same list of events as every relay saying "nothing here": none. The
 * detailed form reports how many relays actually reached EOSE, which is what
 * separates the two - and what a caller deciding whether a post was withdrawn
 * has to look at before believing an empty list.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  queryRelays,
  queryRelaysDetailed,
  type SubscriptionOpener,
} from '../src/common/relay-query.js';
import type { NostrEvent } from '../types/nostr';

function note(id: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 1,
    kind: 1,
    tags: [],
    content: '',
    sig: '',
  } as NostrEvent;
}

/** Relays that behave as scripted: answer with events, close, or refuse. */
function scripted(
  behaviour: Record<string, 'answer' | 'close' | 'refuse' | 'silent'>,
  events: NostrEvent[] = [],
): SubscriptionOpener {
  return async (relayUrl, _filter, subscription) => {
    const what = behaviour[relayUrl] ?? 'silent';
    if (what === 'refuse') throw new Error(`refused by ${relayUrl}`);
    queueMicrotask((): void => {
      if (what === 'answer') {
        for (const event of events) subscription.onEvent?.(event);
        subscription.onEose?.();
      } else if (what === 'close') {
        subscription.onClosed?.('closed');
      }
    });
    return (): void => {};
  };
}

test('relay query: every relay failing is an empty list with nobody answering', async () => {
  const result = await queryRelaysDetailed(
    ['wss://refused', 'wss://closed'],
    { kinds: [5] },
    scripted({ 'wss://refused': 'refuse', 'wss://closed': 'close' }),
  );
  assert.deepEqual(result.events, []);
  assert.equal(result.answered, 0);
});

test('relay query: a relay that reached EOSE with nothing counts as an answer', async () => {
  const result = await queryRelaysDetailed(
    ['wss://empty', 'wss://refused'],
    { kinds: [5] },
    scripted({ 'wss://empty': 'answer', 'wss://refused': 'refuse' }),
  );
  assert.deepEqual(result.events, []);
  assert.equal(result.answered, 1);
});

test('relay query: events come back once each, and the plain form is just the events', async () => {
  const shared: NostrEvent[] = [note('x'), note('y')];
  const open: SubscriptionOpener = scripted(
    { 'wss://a': 'answer', 'wss://b': 'answer' },
    shared,
  );
  const detailed = await queryRelaysDetailed(['wss://a', 'wss://b'], {}, open);
  assert.equal(detailed.answered, 2);
  assert.deepEqual(detailed.events.map((e) => e.id).sort(), ['x', 'y']);
  const plain = await queryRelays(['wss://a', 'wss://b'], {}, open);
  assert.deepEqual(plain.map((e) => e.id).sort(), ['x', 'y']);
});

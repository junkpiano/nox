/**
 * The seams that let one codebase serve a browser and a phone.
 *
 * These three modules were added so React Native could reach shared logic that
 * assumed a browser. They are in shipped web code, so the thing worth pinning
 * is not that native works - the device says that - but that the web behaviour
 * did not move underneath it.
 *
 * They run under Node, with no DOM at all, which is also the point: that is
 * the shape React Native sees, and every one of these modules has to behave
 * without a `window` to lean on.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { emitAppEvent, onAppEvent } from '../src/common/app-events.js';
import { askUser, canAsk, setAsker } from '../src/common/ask.js';
import { kvGet, kvRemove, kvSet, setKvStore } from '../src/common/kv.js';

// --- kv ------------------------------------------------------------------

test('kv: without localStorage it still stores, in memory', () => {
  // Node has no localStorage, so this is the native case exactly.
  kvSet('seam-a', 'one');
  assert.equal(kvGet('seam-a'), 'one');
  kvRemove('seam-a');
  assert.equal(kvGet('seam-a'), null);
});

test('kv: an absent key reads null, not undefined', () => {
  // Callers branch on `=== null`; undefined would slip past that.
  assert.equal(kvGet('seam-never-written'), null);
});

test('kv: installing a store replays what was written before it', () => {
  // The native app installs its store after the module graph has loaded, so
  // anything written during start-up has to survive the handover.
  kvSet('seam-early', 'written before the store arrived');

  const backing: Map<string, string> = new Map();
  setKvStore({
    get: (key: string): string | null => backing.get(key) ?? null,
    set: (key: string, value: string): void => {
      backing.set(key, value);
    },
    remove: (key: string): void => {
      backing.delete(key);
    },
  });

  assert.equal(backing.get('seam-early'), 'written before the store arrived');
  assert.equal(kvGet('seam-early'), 'written before the store arrived');
});

test('kv: after installing, reads and writes go to the new store', () => {
  const backing: Map<string, string> = new Map();
  setKvStore({
    get: (key: string): string | null => backing.get(key) ?? null,
    set: (key: string, value: string): void => {
      backing.set(key, value);
    },
    remove: (key: string): void => {
      backing.delete(key);
    },
  });

  kvSet('seam-b', 'two');
  assert.equal(backing.get('seam-b'), 'two');

  backing.set('seam-c', 'set behind its back');
  assert.equal(kvGet('seam-c'), 'set behind its back');

  kvRemove('seam-b');
  assert.equal(backing.has('seam-b'), false);
});

// --- app-events ----------------------------------------------------------

test('app-events: a listener hears an emit with no window present', () => {
  let heard: unknown = 'nothing';
  const off = onAppEvent('relays-updated', (detail: unknown): void => {
    heard = detail ?? 'fired';
  });

  emitAppEvent('relays-updated');
  off();

  assert.equal(heard, 'fired');
});

test('app-events: detail reaches the listener', () => {
  let heard: unknown = null;
  const off = onAppEvent('mute-list-updated', (detail: unknown): void => {
    heard = detail;
  });

  emitAppEvent('mute-list-updated', { pubkeys: ['abc'] });
  off();

  assert.deepEqual(heard, { pubkeys: ['abc'] });
});

test('app-events: unsubscribing actually stops it', () => {
  let count = 0;
  const off = onAppEvent('wallet-connection-changed', (): void => {
    count += 1;
  });

  emitAppEvent('wallet-connection-changed');
  off();
  emitAppEvent('wallet-connection-changed');

  assert.equal(count, 1);
});

test('app-events: one listener throwing does not rob the others', () => {
  // A screen that unmounts badly must not silence the rest of the app.
  let second = false;
  const offFirst = onAppEvent('relay-health-updated', (): void => {
    throw new Error('deliberate');
  });
  const offSecond = onAppEvent('relay-health-updated', (): void => {
    second = true;
  });

  emitAppEvent('relay-health-updated');
  offFirst();
  offSecond();

  assert.equal(second, true);
});

test('app-events: a listener that unsubscribes itself does not disturb the rest', () => {
  // The set is copied before iterating for exactly this.
  let secondRan = false;
  const offFirst = onAppEvent('dm-messages-updated', (): void => {
    offFirst();
  });
  const offSecond = onAppEvent('dm-messages-updated', (): void => {
    secondRan = true;
  });

  emitAppEvent('dm-messages-updated');
  offSecond();

  assert.equal(secondRan, true);
});

// --- ask -----------------------------------------------------------------

test('ask: with nothing registered the answer is no', () => {
  // This is the shipped web behaviour when window.confirm is unavailable, and
  // it is what React Native gets until a screen answers from settings. A relay
  // demanding NIP-42 must not be granted by default.
  setAsker(null);
  assert.equal(canAsk(), false);
  assert.equal(askUser('sign an auth challenge?'), false);
});

test('ask: a registered asker is used, and sees the message', () => {
  let seen = '';
  setAsker((message: string): boolean => {
    seen = message;
    return true;
  });

  assert.equal(canAsk(), true);
  assert.equal(askUser('allow this relay?'), true);
  assert.equal(seen, 'allow this relay?');

  setAsker(null);
});

test('ask: an asker that throws is treated as no', () => {
  // Failing open here would sign a challenge nobody agreed to.
  setAsker((): boolean => {
    throw new Error('deliberate');
  });

  assert.equal(askUser('allow?'), false);

  setAsker(null);
});

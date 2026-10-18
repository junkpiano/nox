/**
 * Sending an event: one socket per relay, counted only when that relay says
 * OK to this event's id.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  publishAndCount,
  publishEventToRelays,
} from '../src/common/publish-event.js';
import type { NostrEvent } from '../types/nostr';
import {
  type FakeSocket,
  fakeRelays,
  installFakeWebSocket,
  sockets,
  storeRelay,
} from './fake-relay-store.js';

installFakeWebSocket();

const event: NostrEvent = finalizeEvent(
  { kind: 1, created_at: 1_700_000_000, tags: [], content: 'hello' },
  generateSecretKey(),
) as unknown as NostrEvent;

test('each relay that answers OK true is counted, and a refusal or a failure is not', async () => {
  fakeRelays.set('wss://yes.example', storeRelay([], true));
  fakeRelays.set('wss://no.example', storeRelay([], false));
  fakeRelays.set('wss://down.example', { refuse: true });
  const accepted: number = await publishAndCount(event, [
    'wss://yes.example',
    'wss://no.example',
    'wss://down.example',
  ]);
  assert.equal(accepted, 1);
  const yes = sockets.find(
    (socket: FakeSocket): boolean => socket.url === 'wss://yes.example',
  );
  assert.deepEqual(yes?.sent, [['EVENT', JSON.parse(JSON.stringify(event))]]);
  assert.equal(yes?.readyState, 3);
});

test('an OK for some other id, such as an AUTH, does not end the send', async () => {
  fakeRelays.set('wss://auth-first.example', {
    onMessage: (socket: FakeSocket, message: unknown[]): void => {
      if (message[0] !== 'EVENT') return;
      socket.receive(['OK', 'some-auth-event', true, '']);
      socket.receive(['OK', event.id, true, '']);
    },
  });
  assert.equal(await publishAndCount(event, ['wss://auth-first.example']), 1);
});

test('publishing to no relays does nothing and resolves', async () => {
  await publishEventToRelays(event, []);
  assert.equal(await publishAndCount(event, []), 0);
});

test('a relay that never answers is given up on after five seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    fakeRelays.set('wss://silent.example', {});
    const sent: Promise<number> = publishAndCount(event, [
      'wss://silent.example',
    ]);
    await Promise.resolve();
    await Promise.resolve();
    mock.timers.tick(5000);
    assert.equal(await sent, 0);
  } finally {
    mock.timers.reset();
  }
});

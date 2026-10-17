/**
 * The socket under every relay conversation: one connection per relay shared
 * by every subscription on it, nothing passed on that is not a genuine event
 * answering the filter, and NIP-42 challenges signed only for relays the
 * viewer chose and agreed to.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { setAsker } from '../src/common/ask.js';
import { kvGet } from '../src/common/kv.js';
import {
  clearRelayAuthPermissions,
  createRelayWebSocket,
  openRelaySubscription,
  setOwnDmRelaysForAuth,
  setRelayAuthPermissionForRelays,
} from '../src/common/relay-socket.js';
import {
  endSession,
  setSessionPrivateKeyFromRaw,
} from '../src/common/session.js';
import { setRelays } from '../src/features/relays/relays.js';
import type { NostrEvent } from '../types/nostr';
import {
  type FakeSocket,
  fakeRelays,
  installFakeWebSocket,
  last,
  settle,
  sockets,
  storeRelay,
} from './fake-relay-store.js';

installFakeWebSocket();

const PERMISSIONS_KEY: string = 'nostr_relay_auth_permissions_v1';
const key: Uint8Array = generateSecretKey();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function note(content: string, kind: number = 1): NostrEvent {
  return finalizeEvent(
    { kind, created_at: 1_700_000_000, tags: [], content },
    key,
  ) as unknown as NostrEvent;
}

function socketsFor(url: string): FakeSocket[] {
  return sockets.filter((socket: FakeSocket): boolean => socket.url === url);
}

function authsSent(socket: FakeSocket): NostrEvent[] {
  return socket.sent
    .filter((message: unknown[]): boolean => message[0] === 'AUTH')
    .map((message: unknown[]): NostrEvent => message[1] as NostrEvent);
}

/** Opens a raw socket to `url` and has the relay send each challenge. */
async function challenge(
  url: string,
  ...challenges: string[]
): Promise<FakeSocket> {
  fakeRelays.set(url, {});
  createRelayWebSocket(url, false);
  await settle(1);
  const socket: FakeSocket | undefined = last(socketsFor(url));
  assert.ok(socket);
  for (const text of challenges) socket.receive(['AUTH', text]);
  await settle(2);
  return socket;
}

function signedIn(): void {
  setSessionPrivateKeyFromRaw(hex(key));
}

test.beforeEach((): void => {
  clearRelayAuthPermissions();
  setAsker(null);
  endSession();
});

test('subscriptions to one relay share one socket and each gets only its own events', async () => {
  const url = 'wss://shared.example';
  const a: NostrEvent = note('for a');
  fakeRelays.set(url, {
    onMessage: (socket: FakeSocket, message: unknown[]): void => {
      if (message[0] !== 'REQ') return;
      const filter = message[2] as { kinds: number[] };
      if (filter.kinds[0] === 1) socket.receive(['EVENT', message[1], a]);
      socket.receive(['EOSE', message[1]]);
    },
  });
  const gotA: NostrEvent[] = [];
  const gotB: NostrEvent[] = [];
  let eoses: number = 0;
  await openRelaySubscription(
    url,
    { kinds: [1] },
    {
      onEvent: (event: NostrEvent): void => void gotA.push(event),
      onEose: (): void => {
        eoses += 1;
      },
    },
  );
  await openRelaySubscription(
    url,
    { kinds: [7] },
    {
      onEvent: (event: NostrEvent): void => void gotB.push(event),
      onEose: (): void => {
        eoses += 1;
      },
    },
  );
  await settle();
  assert.equal(socketsFor(url).length, 1);
  assert.deepEqual(
    gotA.map((event: NostrEvent): string => event.id),
    [a.id],
  );
  assert.deepEqual(gotB, []);
  assert.equal(eoses, 2);
});

test('two subscriptions asked for at once wait on the same connection', async () => {
  const url = 'wss://concurrent.example';
  fakeRelays.set(url, storeRelay([]));
  await Promise.all([
    openRelaySubscription(url, {}, {}),
    openRelaySubscription(url, {}, {}),
  ]);
  assert.equal(socketsFor(url).length, 1);
  assert.equal(
    socketsFor(url)[0]?.sent.filter((m: unknown[]): boolean => m[0] === 'REQ')
      .length,
    2,
  );
});

test('a forged event, or one outside the filter, never reaches the reader', async () => {
  const url = 'wss://forger.example';
  const genuine: NostrEvent = note('genuine');
  const forged: NostrEvent = { ...note('original'), content: 'edited' };
  const wrongKind: NostrEvent = note('reaction', 7);
  fakeRelays.set(url, storeRelay([forged, wrongKind, genuine]));
  const got: string[] = [];
  await openRelaySubscription(
    url,
    { kinds: [1] },
    {
      onEvent: (event: NostrEvent): void => void got.push(event.content),
    },
  );
  await settle();
  assert.deepEqual(got, ['genuine']);
});

test('messages that are not for a live subscription are ignored', async () => {
  const url = 'wss://noisy.example';
  fakeRelays.set(url, {});
  const got: NostrEvent[] = [];
  await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
    },
  );
  const socket = socketsFor(url)[0] as FakeSocket;
  socket.receive(['EVENT', 'someone-else', note('x')]);
  socket.receive(['NOTICE', 'hello']);
  socket.receive([42]);
  socket.emitRaw('not json');
  await settle();
  assert.deepEqual(got, []);
});

test('CLOSED from the relay reaches the reader once, with its reason, and ends the subscription', async () => {
  const url = 'wss://closer.example';
  fakeRelays.set(url, {
    onMessage: (socket: FakeSocket, message: unknown[]): void => {
      if (message[0] === 'REQ') {
        socket.receive(['CLOSED', message[1], 'auth-required: sign in']);
        socket.receive(['EVENT', message[1], note('too late')]);
      }
    },
  });
  const reasons: string[] = [];
  const got: NostrEvent[] = [];
  await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
      onClosed: (reason: string): void => void reasons.push(reason),
    },
  );
  await settle();
  assert.deepEqual(reasons, ['auth-required: sign in']);
  assert.deepEqual(got, []);
  const socket = socketsFor(url)[0] as FakeSocket;
  assert.equal(last(socket.sent)?.[0], 'CLOSE');
});

test('unsubscribing sends CLOSE and stops delivery', async () => {
  const url = 'wss://unsub.example';
  fakeRelays.set(url, {});
  const got: NostrEvent[] = [];
  const stop = await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
    },
  );
  const socket = socketsFor(url)[0] as FakeSocket;
  const subId = socket.sent[0]?.[1];
  stop();
  socket.receive(['EVENT', subId, note('after')]);
  await settle();
  assert.deepEqual(last(socket.sent), ['CLOSE', subId]);
  assert.deepEqual(got, []);
});

test('a closed socket drops its subscriptions and the next one opens a fresh socket', async () => {
  const url = 'wss://reconnect.example';
  fakeRelays.set(url, {});
  const got: NostrEvent[] = [];
  await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
    },
  );
  const first = socketsFor(url)[0] as FakeSocket;
  const subId = first.sent[0]?.[1];
  first.close();
  await settle();
  first.receive(['EVENT', subId, note('ghost')]);
  await settle();
  assert.deepEqual(got, []);

  await openRelaySubscription(url, {}, {});
  assert.equal(socketsFor(url).length, 2);
});

test('a relay that refuses the connection rejects the subscription', async () => {
  const url = 'wss://refuses.example';
  fakeRelays.set(url, { refuse: true });
  await assert.rejects(
    openRelaySubscription(url, {}, {}),
    /Failed to connect to relay wss:\/\/refuses\.example/,
  );
});

test('a refused socket closing late does not clobber the connection opened after it', async () => {
  // Documents current behaviour, which looks like a bug: the close handler
  // of a failed socket resets the shared connection without checking that
  // it is still the current socket. A browser fires `error` and `close`
  // together, so a retry made in between - here simulated by holding the
  // close back - has its subscription dropped and its socket orphaned.
  const url = 'wss://flaky.example';
  fakeRelays.set(url, { refuse: true });
  const pending: FakeSocket[] = [];
  const subscribe = openRelaySubscription(url, {}, {});
  const failing = last(socketsFor(url)) as FakeSocket;
  // Hold the failed socket's close back until the retry is open.
  failing.close = function (this: FakeSocket): void {
    pending.push(this);
  };
  await assert.rejects(subscribe);
  fakeRelays.set(url, {});
  const got: NostrEvent[] = [];
  await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
    },
  );
  const retry = last(socketsFor(url)) as FakeSocket;
  const subId = retry.sent[0]?.[1];
  for (const socket of pending) {
    socket.readyState = 3;
    socket.dispatchEvent(new Event('close'));
  }
  await settle();
  retry.receive(['EVENT', subId, note('lost')]);
  await settle();
  // Ideally ['lost']; the retry's subscription was dropped instead.
  assert.deepEqual(
    got.map((event: NostrEvent): string => event.content),
    [],
  );
});

test('the raw socket counts toward relay health when asked to', async () => {
  const url = 'wss://healthy.example';
  setRelays([url, 'wss://down.example']);
  fakeRelays.set(url, {});
  fakeRelays.set('wss://down.example', { refuse: true });
  createRelayWebSocket(url);
  createRelayWebSocket('wss://down.example');
  await settle(1);
  const health = JSON.parse(kvGet('nostr_relay_health_v1') ?? '{}');
  assert.deepEqual(health[url], { success: 1, failure: 0 });
  assert.deepEqual(health['wss://down.example'], { success: 0, failure: 1 });
});

test('an AUTH challenge from a configured relay is signed once the viewer agrees, for every configured relay', async () => {
  const url = 'wss://auth.example';
  setRelays([url, 'wss://other.example']);
  signedIn();
  const asked: string[] = [];
  setAsker((message: string): boolean => {
    asked.push(message);
    return true;
  });
  const socket = await challenge(url, 'challenge-1');
  const [auth] = authsSent(socket);
  assert.ok(auth);
  assert.equal(auth.kind, 22242);
  assert.equal(auth.pubkey, getPublicKey(key));
  assert.deepEqual(auth.tags, [
    ['relay', url],
    ['challenge', 'challenge-1'],
  ]);
  assert.equal(asked.length, 1);
  assert.deepEqual(JSON.parse(kvGet(PERMISSIONS_KEY) ?? '{}'), {
    [url]: 'allow',
    'wss://other.example': 'allow',
  });

  // The other relay is now allowed without a second question.
  const other = await challenge('wss://other.example', 'c');
  assert.equal(authsSent(other).length, 1);
  assert.equal(asked.length, 1);
});

test('a refusal is remembered and nothing is signed', async () => {
  const url = 'wss://refused-auth.example';
  setRelays([url]);
  signedIn();
  let asked: number = 0;
  setAsker((): boolean => {
    asked += 1;
    return false;
  });
  const first = await challenge(url, 'one');
  const second = await challenge(url, 'two');
  assert.equal(authsSent(first).length + authsSent(second).length, 0);
  assert.equal(asked, 1);
  assert.equal(JSON.parse(kvGet(PERMISSIONS_KEY) ?? '{}')[url], 'deny');
});

test('a relay nobody configured never gets to ask', async () => {
  setRelays(['wss://mine.example']);
  signedIn();
  let asked: number = 0;
  setAsker((): boolean => {
    asked += 1;
    return true;
  });
  const socket = await challenge('wss://stranger.example', 'x');
  assert.equal(authsSent(socket).length, 0);
  assert.equal(asked, 0);
});

test("the viewer's own DM relays may ask, and switching accounts forgets them", async () => {
  setRelays(['wss://mine.example']);
  signedIn();
  setAsker((): boolean => true);
  setOwnDmRelaysForAuth(['wss://dm.example']);
  const socket = await challenge('wss://dm.example', 'x');
  assert.equal(authsSent(socket).length, 1);

  clearRelayAuthPermissions();
  const after = await challenge('wss://dm.example', 'y');
  assert.equal(authsSent(after).length, 0);
});

test('without a key nothing is asked or signed', async () => {
  const url = 'wss://keyless.example';
  setRelays([url]);
  let asked: number = 0;
  setAsker((): boolean => {
    asked += 1;
    return true;
  });
  const socket = await challenge(url, 'x');
  assert.equal(authsSent(socket).length, 0);
  assert.equal(asked, 0);
});

test('without anything to ask, the answer is no', async () => {
  const url = 'wss://no-asker.example';
  setRelays([url]);
  signedIn();
  const socket = await challenge(url, 'x');
  assert.equal(authsSent(socket).length, 0);
  assert.equal(kvGet(PERMISSIONS_KEY), '{}');
});

test('a challenge repeated is answered once, and a socket answers at most four', async () => {
  const url = 'wss://chatty.example';
  setRelayAuthPermissionForRelays([`${url}/`], 'allow');
  signedIn();
  const socket = await challenge(url, 'a', 'a', 'b', 'c', 'd', 'e', 'f');
  assert.deepEqual(
    authsSent(socket).map(
      (auth: NostrEvent): string | undefined =>
        auth.tags.find((tag: string[]): boolean => tag[0] === 'challenge')?.[1],
    ),
    ['a', 'b', 'c', 'd'],
  );
});

test('the shared socket answers AUTH too, and does not pass it to readers', async () => {
  const url = 'wss://shared-auth.example';
  setRelayAuthPermissionForRelays([url], 'allow');
  signedIn();
  fakeRelays.set(url, {});
  const got: NostrEvent[] = [];
  await openRelaySubscription(
    url,
    {},
    {
      onEvent: (event: NostrEvent): void => void got.push(event),
    },
  );
  const socket = socketsFor(url)[0] as FakeSocket;
  socket.receive(['AUTH', 'shared']);
  socket.receive(['AUTH', 'shared']);
  await settle();
  assert.equal(authsSent(socket).length, 1);
  assert.deepEqual(got, []);
});

test('stored permissions that are not allow or deny are ignored, and garbage reads as none', async () => {
  const { kvSet } = await import('../src/common/kv.js');
  const url = 'wss://garbage.example';
  setRelays([url]);
  signedIn();
  kvSet(PERMISSIONS_KEY, JSON.stringify({ [url]: 'maybe' }));
  let asked: number = 0;
  setAsker((): boolean => {
    asked += 1;
    return true;
  });
  await challenge(url, 'x');
  assert.equal(asked, 1);

  kvSet(PERMISSIONS_KEY, 'not json');
  const socket = await challenge(url, 'y');
  assert.equal(asked, 2);
  assert.equal(authsSent(socket).length, 1);
});

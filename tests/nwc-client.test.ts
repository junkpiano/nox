/**
 * NIP-47 wallet connect: reading the connection string, and one request and
 * its response over a relay.
 *
 * The relay and the wallet behind it are played by a fake WebSocket that
 * decrypts each kind 23194 request with the wallet's own key and answers
 * with a kind 23195 response, so the encryption is real in both directions.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
} from 'nostr-tools';
import {
  getBalance,
  getInfo,
  listTransactions,
  type NwcConnection,
  NwcError,
  parseNwcUri,
  payInvoice,
} from '../src/features/wallet/nwc-client.js';
import type { NostrEvent } from '../types/nostr';
import { FakeWebSocket, installFakeWebSocket } from './fakes/fake-websocket.js';

const walletKey: Uint8Array = generateSecretKey();
const WALLET: string = getPublicKey(walletKey);
const SECRET: string = 'ab'.repeat(32);
const CLIENT: string = getPublicKey(
  Uint8Array.from(Buffer.from(SECRET, 'hex')),
);
const CONNECTION: NwcConnection = {
  walletPubkey: WALLET,
  relay: 'wss://relay.example.com',
  secret: SECRET,
};

// --- the connection string ------------------------------------------------

test('a connection string yields the wallet key, relay, secret and lightning address', () => {
  const parsed: NwcConnection = parseNwcUri(
    `  nostr+walletconnect://${'A'.repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${'B'.repeat(64)}&lud16=me%40example.com  `,
  );
  assert.deepEqual(parsed, {
    walletPubkey: 'a'.repeat(64),
    relay: 'wss://relay.example.com',
    secret: 'b'.repeat(64),
    lud16: 'me@example.com',
  });
});

test('a connection string without a lightning address has no lud16 key at all', () => {
  const parsed: NwcConnection = parseNwcUri(
    `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://r.example&secret=${'b'.repeat(64)}`,
  );
  assert.equal('lud16' in parsed, false);
});

test('the wallet key may sit in the path when written with three slashes', () => {
  const parsed: NwcConnection = parseNwcUri(
    `nostr+walletconnect:///${'a'.repeat(64)}?relay=wss://r.example&secret=${'b'.repeat(64)}`,
  );
  assert.equal(parsed.walletPubkey, 'a'.repeat(64));
});

test('a connection string says which part is wrong', () => {
  const key: string = 'a'.repeat(64);
  const secret: string = 'b'.repeat(64);
  assert.throws(
    () => parseNwcUri('https://example.com'),
    /Not a wallet connection string/,
  );
  assert.throws(
    () =>
      parseNwcUri(`nostr+walletconnect://xyz?relay=wss://r&secret=${secret}`),
    /no valid wallet key/,
  );
  assert.throws(
    () => parseNwcUri(`nostr+walletconnect://${key}?secret=${secret}`),
    /no relay/,
  );
  assert.throws(
    () => parseNwcUri(`nostr+walletconnect://${key}?relay=wss://r`),
    /no valid secret/,
  );
  assert.throws(
    () =>
      parseNwcUri(`nostr+walletconnect://${key}?relay=wss://r&secret=short`),
    /no valid secret/,
  );
});

test('a connection string that is not a URL at all is called malformed', () => {
  assert.throws(
    () => parseNwcUri('nostr+walletconnect://[not a host'),
    /Malformed wallet connection string/,
  );
});

// --- requests ---------------------------------------------------------------

type WalletAnswer =
  | { result: unknown }
  | { error: { code?: string; message?: string } };

interface SeenRequest {
  method: string;
  params: Record<string, unknown>;
  event: NostrEvent;
  subscription: Record<string, unknown>;
}

/** Plays the relay and the wallet: answers each request with `answer`. */
function wallet(answer: (method: string) => WalletAnswer): SeenRequest[] {
  installFakeWebSocket();
  const seen: SeenRequest[] = [];
  let subscription: Record<string, unknown> = {};
  FakeWebSocket.respond = (_socket, frame, reply): void => {
    if (frame[0] === 'REQ') {
      subscription = frame[2] as Record<string, unknown>;
      return;
    }
    if (frame[0] !== 'EVENT') return;
    const event = frame[1] as NostrEvent;
    void (async (): Promise<void> => {
      const body = JSON.parse(
        await nip04.decrypt(walletKey, event.pubkey, event.content),
      ) as { method: string; params: Record<string, unknown> };
      seen.push({ ...body, event, subscription });
      const response = finalizeEvent(
        {
          kind: 23195,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', event.pubkey],
            ['e', event.id],
          ],
          content: await nip04.encrypt(
            walletKey,
            event.pubkey,
            JSON.stringify({
              result_type: body.method,
              ...answer(body.method),
            }),
          ),
        },
        walletKey,
      );
      reply(['OK', event.id, true, '']);
      reply(['EVENT', 'sub', response]);
    })();
  };
  return seen;
}

test('get_info is sent as an encrypted, signed kind 23194 request after subscribing for the answer', async () => {
  const seen: SeenRequest[] = wallet(() => ({
    result: { alias: 'My Wallet', methods: ['pay_invoice', 'get_balance'] },
  }));
  const info = await getInfo(CONNECTION);
  assert.deepEqual(info, {
    alias: 'My Wallet',
    methods: ['pay_invoice', 'get_balance'],
  });

  const request: SeenRequest | undefined = seen[0];
  assert.ok(request);
  assert.equal(request.method, 'get_info');
  assert.deepEqual(request.params, {});
  assert.equal(request.event.kind, 23194);
  assert.equal(request.event.pubkey, CLIENT);
  assert.deepEqual(request.event.tags, [['p', WALLET]]);
  // The subscription went out first, and asks for this request's answer only.
  assert.deepEqual(request.subscription, {
    kinds: [23195],
    authors: [WALLET],
    '#p': [CLIENT],
    '#e': [request.event.id],
    limit: 1,
  });
  const socket: FakeWebSocket | undefined = FakeWebSocket.opened[0];
  assert.equal(socket?.sent[0]?.[0], 'REQ');
  assert.equal(socket?.sent[1]?.[0], 'EVENT');
  // One socket per request, closed once answered.
  assert.equal(socket?.readyState, FakeWebSocket.CLOSED);
});

test('get_info without an alias or a method list reports no alias and no methods', async () => {
  wallet(() => ({ result: {} }));
  assert.deepEqual(await getInfo(CONNECTION), { methods: [] });
});

test('the balance comes back in whole sats, rounded down from millisats', async () => {
  wallet(() => ({ result: { balance: 21_999 } }));
  assert.equal(await getBalance(CONNECTION), 21);
  wallet(() => ({ result: {} }));
  assert.equal(await getBalance(CONNECTION), 0);
});

test('transactions are mapped into sats with defaults for missing fields', async () => {
  const seen: SeenRequest[] = wallet(() => ({
    result: {
      transactions: [
        {
          type: 'incoming',
          amount: 5_500,
          description: 'coffee',
          settled_at: 1_700_000_000,
        },
        { type: 'weird', amount: undefined, description: 42 },
      ],
    },
  }));
  assert.deepEqual(await listTransactions(CONNECTION, 5), [
    {
      type: 'incoming',
      amountSats: 5,
      description: 'coffee',
      settledAt: 1_700_000_000,
    },
    { type: 'outgoing', amountSats: 0, description: '', settledAt: null },
  ]);
  assert.deepEqual(seen[0]?.params, { limit: 5 });

  wallet(() => ({ result: { transactions: 'nope' } }));
  assert.deepEqual(await listTransactions(CONNECTION), []);
});

test('paying an invoice returns the preimage and the fee in sats', async () => {
  const seen: SeenRequest[] = wallet(() => ({
    result: { preimage: 'ff'.repeat(32), fees_paid: 3_000 },
  }));
  assert.deepEqual(await payInvoice(CONNECTION, 'lnbc1invoice'), {
    preimage: 'ff'.repeat(32),
    feesPaid: 3,
  });
  assert.deepEqual(seen[0]?.params, { invoice: 'lnbc1invoice' });

  wallet(() => ({ result: { preimage: 'aa' } }));
  assert.deepEqual(await payInvoice(CONNECTION, 'lnbc1invoice'), {
    preimage: 'aa',
  });
});

test('a payment the wallet reports without a preimage is not treated as paid', async () => {
  wallet(() => ({ result: {} }));
  await assert.rejects(
    payInvoice(CONNECTION, 'lnbc1invoice'),
    (error: unknown): boolean =>
      error instanceof NwcError && error.code === 'NO_PREIMAGE',
  );
});

test("the wallet's own error code and message are passed on", async () => {
  wallet(() => ({
    error: { code: 'INSUFFICIENT_BALANCE', message: 'not enough sats' },
  }));
  await assert.rejects(
    getBalance(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError &&
      error.code === 'INSUFFICIENT_BALANCE' &&
      error.message === 'not enough sats' &&
      error.name === 'NwcError',
  );

  wallet(() => ({ error: {} }));
  await assert.rejects(
    getBalance(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError &&
      error.code === 'ERROR' &&
      /refused/.test(error.message),
  );
});

test('a relay that refuses the request event rejects with its reason', async () => {
  installFakeWebSocket();
  FakeWebSocket.respond = (_socket, frame, reply): void => {
    if (frame[0] === 'EVENT') {
      reply(['NOTICE', 'ignored']);
      reply(['OK', (frame[1] as NostrEvent).id, false, 'blocked: no wallets']);
    }
  };
  await assert.rejects(
    getInfo(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError &&
      error.code === 'REJECTED' &&
      error.message === 'blocked: no wallets',
  );

  FakeWebSocket.respond = (_socket, frame, reply): void => {
    if (frame[0] === 'EVENT') reply(['OK', 'x', false]);
  };
  await assert.rejects(getInfo(CONNECTION), /relay rejected the request/);
});

test('a reply that cannot be decrypted is reported as unreadable', async () => {
  installFakeWebSocket();
  FakeWebSocket.respond = (socket, frame, reply): void => {
    if (frame[0] !== 'EVENT') return;
    // Noise first: not JSON, and an event of the wrong kind. Both are ignored.
    setTimeout((): void => socket.receive('not json'), 0);
    reply(['EVENT', 'sub', { kind: 1, content: '' }]);
    reply(['EVENT', 'sub']);
    reply(['EVENT', 'sub', { kind: 23195, content: 'garbage?iv=nope' }]);
  };
  await assert.rejects(
    getInfo(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError && error.code === 'DECRYPT_FAILED',
  );
});

test('a relay that cannot be reached, or a relay URL that cannot be opened, is a relay error', async () => {
  installFakeWebSocket();
  FakeWebSocket.mode = 'error';
  await assert.rejects(
    getInfo(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError && error.code === 'RELAY_ERROR',
  );

  FakeWebSocket.mode = 'throw';
  await assert.rejects(
    getInfo(CONNECTION),
    (error: unknown): boolean =>
      error instanceof NwcError && error.code === 'RELAY_ERROR',
  );
});

test('a wallet that never answers times out after thirty seconds', async () => {
  installFakeWebSocket();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending: Promise<unknown> = getInfo(CONNECTION);
    // nip04 encryption is async; let the request reach the socket first.
    await new Promise<void>((resolve): void => {
      setImmediate(resolve);
    });
    mock.timers.tick(30_000);
    await assert.rejects(
      pending,
      (error: unknown): boolean =>
        error instanceof NwcError && error.code === 'TIMEOUT',
    );
  } finally {
    mock.timers.reset();
  }
});

/**
 * Who a message is for, and where it is delivered.
 *
 * The recipient comes from whatever was pasted - hex, npub, nprofile, a
 * `nostr:` link or a NIP-05 name. Delivery goes to the recipient's kind 10050
 * DM relays, else their NIP-65 read relays plus the sender's own.
 *
 * Relays are played by a fake WebSocket answering with real signed events;
 * NIP-05 lookups by a fetch handed to nostr-tools.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip05,
  nip19,
} from 'nostr-tools';
import { type KvStore, setKvStore } from '../src/common/kv.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import {
  DM_RELAY_LIST_KIND,
  fetchDmRelayList,
  fetchNip65ReadRelays,
  invalidateDmRelayCache,
  resolveDeliveryRelays,
  signDmRelayListEvent,
} from '../src/features/messages/dm-relays.js';
import { resolveRecipient } from '../src/features/messages/resolve-recipient.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import { FakeWebSocket, installFakeWebSocket } from './fakes/fake-websocket.js';

const bob: Uint8Array = generateSecretKey();
const BOB: PubkeyHex = getPublicKey(bob) as PubkeyHex;

// --- resolving a recipient --------------------------------------------------

test('a hex pubkey is accepted in any case, and a nostr: prefix is ignored', async () => {
  assert.equal(await resolveRecipient(`  ${BOB.toUpperCase()} `), BOB);
  assert.equal(await resolveRecipient(`nostr:${BOB}`), BOB);
});

test('an npub and an nprofile both resolve to the pubkey they carry', async () => {
  assert.equal(await resolveRecipient(nip19.npubEncode(BOB)), BOB);
  assert.equal(
    await resolveRecipient(
      `nostr:${nip19.nprofileEncode({ pubkey: BOB, relays: ['wss://r.example'] })}`,
    ),
    BOB,
  );
});

test('an npub that does not decode is reported as such', async () => {
  await assert.rejects(
    resolveRecipient('npub1garbage'),
    /could not be decoded/,
  );
});

test('empty input and unrecognisable input ask for an npub or a name', async () => {
  await assert.rejects(resolveRecipient('   '), /Enter an npub/);
  await assert.rejects(resolveRecipient('nostr:'), /Enter an npub/);
  await assert.rejects(resolveRecipient('just some words'), /Enter an npub/);
});

test('a NIP-05 name is looked up at its domain', async () => {
  const asked: string[] = [];
  nip05.useFetchImplementation(async (url: string): Promise<Response> => {
    asked.push(url);
    return new Response(JSON.stringify({ names: { bob: BOB } }));
  });
  assert.equal(await resolveRecipient('bob@example.com'), BOB);
  assert.match(
    asked[0] ?? '',
    /^https:\/\/example\.com\/\.well-known\/nostr\.json\?name=bob/,
  );
});

test('a NIP-05 name nobody answers for cannot be found', async () => {
  const quiet = console.error;
  console.error = (): void => {};
  try {
    nip05.useFetchImplementation(async (): Promise<Response> => {
      return new Response(JSON.stringify({ names: {} }));
    });
    await assert.rejects(
      resolveRecipient('nobody@example.com'),
      /Could not find nobody@example.com/,
    );

    nip05.useFetchImplementation(async (): Promise<Response> => {
      throw new Error('offline');
    });
    await assert.rejects(resolveRecipient('bob@example.com'), /Could not find/);
  } finally {
    console.error = quiet;
  }
});

// --- choosing delivery relays -----------------------------------------------

test("the recipient's DM relays win outright, without duplicates", () => {
  assert.deepEqual(
    resolveDeliveryRelays(
      ['wss://dm.a', 'wss://dm.a', 'wss://dm.b'],
      ['wss://own'],
      ['wss://read'],
    ),
    ['wss://dm.a', 'wss://dm.b'],
  );
});

test('without DM relays, their read relays come first and own relays stay in the set', () => {
  assert.deepEqual(
    resolveDeliveryRelays(
      [],
      ['wss://own', 'wss://shared'],
      ['wss://read', 'wss://shared'],
    ),
    ['wss://read', 'wss://shared', 'wss://own'],
  );
  assert.deepEqual(resolveDeliveryRelays([], ['wss://own']), ['wss://own']);
});

// --- reading relay lists from relays ----------------------------------------

/** Relays that answer every REQ with whichever of `events` match it. */
function relaysHolding(events: NostrEvent[]): void {
  installFakeWebSocket();
  FakeWebSocket.respond = (_socket, frame, reply): void => {
    if (frame[0] !== 'REQ') return;
    const subId = frame[1] as string;
    const filter = frame[2] as { kinds?: number[]; authors?: string[] };
    for (const event of events) {
      if (
        (filter.kinds ?? [event.kind]).includes(event.kind) &&
        (filter.authors ?? [event.pubkey]).includes(event.pubkey)
      ) {
        reply(['EVENT', subId, event]);
      }
    }
    reply(['EOSE', subId]);
  };
}

function listEvent(
  kind: number,
  tags: string[][],
  createdAt: number,
  key: Uint8Array = bob,
): NostrEvent {
  return finalizeEvent(
    { kind, created_at: createdAt, tags, content: '' },
    key,
  ) as NostrEvent;
}

test('a DM relay list keeps only websocket URLs from relay tags, newest list first', async () => {
  relaysHolding([
    listEvent(DM_RELAY_LIST_KIND, [['relay', 'wss://old.example']], 100),
    listEvent(
      DM_RELAY_LIST_KIND,
      [
        ['relay', ' wss://dm.example '],
        ['relay', 'ws://plain.example'],
        ['relay', 'https://not-a-relay.example'],
        ['r', 'wss://wrong-tag.example'],
        ['relay'],
      ],
      200,
    ),
  ]);
  assert.deepEqual(await fetchDmRelayList(BOB, ['wss://search.example']), [
    'wss://dm.example',
    'ws://plain.example',
  ]);
});

test('a DM relay list is cached per pubkey until invalidated', async () => {
  relaysHolding([
    listEvent(DM_RELAY_LIST_KIND, [['relay', 'wss://first.example']], 100),
  ]);
  invalidateDmRelayCache(BOB);
  assert.deepEqual(await fetchDmRelayList(BOB, ['wss://a.example']), [
    'wss://first.example',
  ]);

  relaysHolding([
    listEvent(DM_RELAY_LIST_KIND, [['relay', 'wss://second.example']], 300),
  ]);
  assert.deepEqual(await fetchDmRelayList(BOB, ['wss://b.example']), [
    'wss://first.example',
  ]);
  invalidateDmRelayCache(BOB);
  assert.deepEqual(await fetchDmRelayList(BOB, ['wss://c.example']), [
    'wss://second.example',
  ]);
});

test('someone with no DM relay list has an empty one', async () => {
  const carol: PubkeyHex = getPublicKey(generateSecretKey()) as PubkeyHex;
  relaysHolding([]);
  assert.deepEqual(await fetchDmRelayList(carol, ['wss://d.example']), []);
});

test('a DM relay list signed by someone else is not believed', async () => {
  const carol: PubkeyHex = getPublicKey(generateSecretKey()) as PubkeyHex;
  const forged: NostrEvent = {
    ...listEvent(DM_RELAY_LIST_KIND, [['relay', 'wss://evil.example']], 100),
    pubkey: carol,
  };
  relaysHolding([forged]);
  assert.deepEqual(await fetchDmRelayList(carol, ['wss://e.example']), []);
});

test('NIP-65 read relays are the read-marked and unmarked r tags, deduplicated', async () => {
  relaysHolding([
    listEvent(
      10002,
      [
        ['r', 'wss://both.example'],
        ['r', 'wss://read.example', 'read'],
        ['r', 'wss://write.example', 'write'],
        ['r', ' wss://both.example ', ''],
        ['relay', 'wss://other.example'],
      ],
      100,
    ),
  ]);
  assert.deepEqual(await fetchNip65ReadRelays(BOB, ['wss://f.example']), [
    'wss://both.example',
    'wss://read.example',
  ]);
});

test('no NIP-65 list means no read relays', async () => {
  relaysHolding([]);
  assert.deepEqual(await fetchNip65ReadRelays(BOB, ['wss://g.example']), []);
});

// --- publishing one's own list ----------------------------------------------

test('a DM relay list is signed as kind 10050 with one relay tag per URL', async () => {
  const held: Map<string, string> = new Map();
  const store: KvStore = {
    get: (key: string): string | null => held.get(key) ?? null,
    set: (key: string, value: string): void => {
      held.set(key, value);
    },
    remove: (key: string): void => {
      held.delete(key);
    },
  };
  setKvStore(store);
  const warn = console.warn;
  console.warn = (): void => {};
  try {
    setSessionPrivateKeyFromRaw(nip19.nsecEncode(bob));
    const event: NostrEvent = await signDmRelayListEvent({
      pubkeyHex: BOB,
      relayUrls: ['wss://a.example', 'wss://b.example'],
    });
    assert.equal(event.kind, 10050);
    assert.equal(event.pubkey, BOB);
    assert.equal(event.content, '');
    assert.deepEqual(event.tags, [
      ['relay', 'wss://a.example'],
      ['relay', 'wss://b.example'],
    ]);
    assert.equal(event.sig.length, 128);
  } finally {
    console.warn = warn;
  }
});

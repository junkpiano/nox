/**
 * A private message is believed only through a seal its sender signed.
 *
 * The wrap is signed by a throwaway key and the rumor is not signed at all,
 * so the seal's signature is the one statement of who wrote the message.
 * A seal that decrypts but does not verify is dropped.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
  nip44,
} from 'nostr-tools';
import { type KvStore, setKvStore } from '../src/common/kv.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import { unwrapChatMessage } from '../src/features/messages/nip17.js';
import type { NostrEvent } from '../types/nostr';

const alice = generateSecretKey();
const ALICE = getPublicKey(alice);
const bob = generateSecretKey();
const BOB = getPublicKey(bob);

function inMemoryStore(): void {
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
}

/** Alice's seal for Bob, wrapped for Bob, with its signature as given. */
function wrapFromAlice(
  text: string,
  signature: (seal: NostrEvent) => string,
): NostrEvent {
  const rumor = {
    id: '',
    pubkey: ALICE,
    created_at: 1_800_000_000,
    kind: 14,
    tags: [['p', BOB]],
    content: text,
  };
  rumor.id = getEventHash(
    rumor as unknown as Parameters<typeof getEventHash>[0],
  );
  const signed = finalizeEvent(
    {
      kind: 13,
      created_at: 1_800_000_000,
      tags: [],
      content: nip44.encrypt(
        JSON.stringify(rumor),
        nip44.getConversationKey(alice, BOB),
      ),
    },
    alice,
  );
  const seal: NostrEvent = JSON.parse(JSON.stringify(signed)) as NostrEvent;
  seal.sig = signature(seal);
  const wrapKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: 1_800_000_000,
      tags: [['p', BOB]],
      content: nip44.encrypt(
        JSON.stringify(seal),
        nip44.getConversationKey(wrapKey, BOB),
      ),
    },
    wrapKey,
  ) as unknown as NostrEvent;
}

test('unwrap: a message in a seal its sender signed is read', async () => {
  inMemoryStore();
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(bob));
  const rumor = await unwrapChatMessage(
    wrapFromAlice('hello bob', (seal: NostrEvent): string => seal.sig),
  );
  assert.equal(rumor?.content, 'hello bob');
  assert.equal(rumor?.pubkey, ALICE);
});

test('unwrap: a seal that decrypts but does not verify is dropped', async () => {
  inMemoryStore();
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(bob));
  // Encrypted exactly as a real one, with a signature that is not Alice's.
  const rumor = await unwrapChatMessage(
    wrapFromAlice('not from alice', (): string => '0'.repeat(128)),
  );
  assert.equal(rumor, null);
});

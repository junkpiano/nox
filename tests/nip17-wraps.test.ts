/**
 * Sealing and unwrapping a private message, both ways round.
 *
 * One message makes two wraps: one the recipient can open, and one back to
 * the sender so their own history survives on relays. The rumor names the
 * recipient in its `p` tag whichever copy it travels in, and each wrap is
 * signed by a throwaway key so nothing public links it to the sender.
 *
 * Both key sources are exercised: a key held in the session, and a NIP-07
 * extension that signs and encrypts without ever handing the key over.
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
import {
  endSession,
  ReadOnlySessionError,
  setSessionPrivateKeyFromRaw,
  startReadOnlySession,
} from '../src/common/session.js';
import {
  buildGiftWraps,
  CHAT_KIND,
  canUseDirectMessages,
  GIFT_WRAP_KIND,
  unwrapChatMessage,
} from '../src/features/messages/nip17.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import { installFakeStorage } from './fakes/fake-storage.js';

const alice: Uint8Array = generateSecretKey();
const ALICE: PubkeyHex = getPublicKey(alice) as PubkeyHex;
const bob: Uint8Array = generateSecretKey();
const BOB: PubkeyHex = getPublicKey(bob) as PubkeyHex;

function freshSession(): void {
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
  installFakeStorage();
  endSession();
  (globalThis as { window?: unknown }).window = {};
}

function signInAs(key: Uint8Array): void {
  freshSession();
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(key));
}

interface FakeExtension {
  getPublicKey: () => Promise<string>;
  signEvent?: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

/** A NIP-07 extension holding `key`, with the parts asked for. */
function extensionFor(
  key: Uint8Array,
  parts: { sign: boolean; nip44: boolean },
): FakeExtension {
  const extension: FakeExtension = {
    getPublicKey: async (): Promise<string> => getPublicKey(key),
  };
  if (parts.sign) {
    extension.signEvent = async (
      event: Omit<NostrEvent, 'id' | 'sig'>,
    ): Promise<NostrEvent> => finalizeEvent(event, key) as NostrEvent;
  }
  if (parts.nip44) {
    extension.nip44 = {
      encrypt: async (pubkey: string, plaintext: string): Promise<string> =>
        nip44.encrypt(plaintext, nip44.getConversationKey(key, pubkey)),
      decrypt: async (pubkey: string, ciphertext: string): Promise<string> =>
        nip44.decrypt(ciphertext, nip44.getConversationKey(key, pubkey)),
    };
  }
  return extension;
}

function useExtension(extension: FakeExtension): void {
  freshSession();
  (globalThis as { window?: unknown }).window = { nostr: extension };
}

/** A wrap for Bob around whatever seal and rumor a test wants. */
function handMadeWrap(options: {
  sealKind?: number;
  sealer?: Uint8Array;
  rumor: unknown;
}): NostrEvent {
  const sealer: Uint8Array = options.sealer ?? alice;
  const seal = finalizeEvent(
    {
      kind: options.sealKind ?? 13,
      created_at: 1_800_000_000,
      tags: [],
      content: nip44.encrypt(
        JSON.stringify(options.rumor),
        nip44.getConversationKey(sealer, BOB),
      ),
    },
    sealer,
  );
  const wrapKey: Uint8Array = generateSecretKey();
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

function rumorFrom(
  author: PubkeyHex,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const rumor: Record<string, unknown> = {
    id: '',
    pubkey: author,
    created_at: 1_800_000_000,
    kind: 14,
    tags: [['p', BOB]],
    content: 'hi',
    ...overrides,
  };
  if (!rumor.id) {
    rumor.id = getEventHash(
      rumor as unknown as Parameters<typeof getEventHash>[0],
    );
  }
  return rumor;
}

test('one message makes two wraps: one to the recipient and one back to the sender', async () => {
  signInAs(alice);
  const wraps: NostrEvent[] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'hello bob',
  });

  assert.equal(wraps.length, 2);
  assert.deepEqual(
    wraps.map((wrap: NostrEvent): string[][] => wrap.tags),
    [[['p', BOB]], [['p', ALICE]]],
  );
  for (const wrap of wraps) {
    assert.equal(wrap.kind, GIFT_WRAP_KIND);
    // Signed by a throwaway key, never by the sender.
    assert.notEqual(wrap.pubkey, ALICE);
    assert.ok(!wrap.content.includes('hello bob'));
  }
  assert.notEqual(wraps[0]?.pubkey, wraps[1]?.pubkey);
});

test('wrap and seal timestamps are pushed up to two days into the past, never forward', async () => {
  signInAs(alice);
  const before: number = Math.floor(Date.now() / 1000);
  const wraps: NostrEvent[] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'when?',
  });
  for (const wrap of wraps) {
    assert.ok(wrap.created_at <= before + 1);
    assert.ok(wrap.created_at >= before - 172_800);
  }
});

test('the recipient opens their wrap and finds the sender, the text and a p tag naming themselves', async () => {
  signInAs(alice);
  const [toBob] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'hello bob',
  });
  assert.ok(toBob);

  signInAs(bob);
  const rumor = await unwrapChatMessage(toBob);
  assert.ok(rumor);
  assert.equal(rumor.kind, CHAT_KIND);
  assert.equal(rumor.pubkey, ALICE);
  assert.equal(rumor.content, 'hello bob');
  assert.deepEqual(rumor.tags, [['p', BOB]]);
  assert.equal(
    rumor.id,
    getEventHash(rumor as unknown as Parameters<typeof getEventHash>[0]),
  );
});

test("the sender's own copy opens for the sender, still naming the recipient, and not for the recipient", async () => {
  signInAs(alice);
  const [toBob, toSelf] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'for the record',
  });
  assert.ok(toBob && toSelf);

  const mine = await unwrapChatMessage(toSelf);
  assert.equal(mine?.content, 'for the record');
  assert.deepEqual(mine?.tags, [['p', BOB]]);

  signInAs(bob);
  const theirs = await unwrapChatMessage(toBob);
  // Both wraps carry the same rumor.
  assert.equal(theirs?.id, mine?.id);
  assert.equal(await unwrapChatMessage(toSelf), null);
});

test('a reply carries an e tag pointing at the message it answers', async () => {
  signInAs(alice);
  const [toBob] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'yes',
    replyToEventId: 'c'.repeat(64),
  });
  assert.ok(toBob);
  signInAs(bob);
  const rumor = await unwrapChatMessage(toBob);
  assert.deepEqual(rumor?.tags, [
    ['p', BOB],
    ['e', 'c'.repeat(64)],
  ]);
});

test('a NIP-07 extension can seal and open messages without handing over the key', async () => {
  useExtension(extensionFor(alice, { sign: true, nip44: true }));
  assert.equal(canUseDirectMessages(), true);
  const [toBob, toSelf] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'from the extension',
  });
  assert.ok(toBob && toSelf);
  assert.equal(
    (await unwrapChatMessage(toSelf))?.content,
    'from the extension',
  );

  useExtension(extensionFor(bob, { sign: false, nip44: true }));
  assert.equal((await unwrapChatMessage(toBob))?.content, 'from the extension');
});

test('direct messages are available with a session key, or an extension that both signs and encrypts', () => {
  signInAs(alice);
  assert.equal(canUseDirectMessages(), true);

  useExtension(extensionFor(alice, { sign: false, nip44: true }));
  assert.equal(canUseDirectMessages(), false);

  useExtension(extensionFor(alice, { sign: true, nip44: false }));
  assert.equal(canUseDirectMessages(), false);

  freshSession();
  assert.equal(canUseDirectMessages(), false);
});

test('without any key a message cannot be sealed, and a wrap cannot be opened', async () => {
  signInAs(alice);
  const [toBob] = await buildGiftWraps({
    senderPubkey: ALICE,
    recipientPubkey: BOB,
    message: 'x',
  });
  assert.ok(toBob);

  freshSession();
  await assert.rejects(
    buildGiftWraps({ senderPubkey: ALICE, recipientPubkey: BOB, message: 'x' }),
    /No key available to encrypt/,
  );
  assert.equal(await unwrapChatMessage(toBob), null);
});

test('an extension that encrypts but cannot sign is refused at the seal', async () => {
  useExtension(extensionFor(alice, { sign: false, nip44: true }));
  await assert.rejects(
    buildGiftWraps({ senderPubkey: ALICE, recipientPubkey: BOB, message: 'x' }),
    /No signing method available/,
  );
});

test('a read-only session never signs a seal, even with an extension present', async () => {
  useExtension(extensionFor(alice, { sign: true, nip44: true }));
  startReadOnlySession(ALICE);
  await assert.rejects(
    buildGiftWraps({ senderPubkey: ALICE, recipientPubkey: BOB, message: 'x' }),
    ReadOnlySessionError,
  );
});

test('a hand-made wrap with a well-formed rumor opens', async () => {
  signInAs(bob);
  const rumor = await unwrapChatMessage(
    handMadeWrap({ rumor: rumorFrom(ALICE) }),
  );
  assert.equal(rumor?.content, 'hi');
});

test('a wrap whose inner event is not a seal is dropped', async () => {
  signInAs(bob);
  assert.equal(
    await unwrapChatMessage(
      handMadeWrap({ sealKind: 1, rumor: rumorFrom(ALICE) }),
    ),
    null,
  );
});

test('a rumor that is not a chat message is dropped', async () => {
  signInAs(bob);
  assert.equal(
    await unwrapChatMessage(
      handMadeWrap({ rumor: rumorFrom(ALICE, { kind: 1 }) }),
    ),
    null,
  );
});

test('a rumor without tags, or with a non-string tag item, is dropped rather than thrown', async () => {
  signInAs(bob);
  // Given an id up front: these shapes cannot be hashed.
  const noTags = rumorFrom(ALICE, { id: 'f'.repeat(64) });
  delete noTags.tags;
  assert.equal(await unwrapChatMessage(handMadeWrap({ rumor: noTags })), null);
  assert.equal(
    await unwrapChatMessage(
      handMadeWrap({
        rumor: rumorFrom(ALICE, { id: 'f'.repeat(64), tags: [['p', 7]] }),
      }),
    ),
    null,
  );
  assert.equal(await unwrapChatMessage(handMadeWrap({ rumor: null })), null);
});

test('a rumor claiming an author other than the one who signed the seal is dropped', async () => {
  signInAs(bob);
  const mallory: Uint8Array = generateSecretKey();
  // Mallory seals a rumor that says Alice wrote it.
  assert.equal(
    await unwrapChatMessage(
      handMadeWrap({ sealer: mallory, rumor: rumorFrom(ALICE) }),
    ),
    null,
  );
});

test('a wrap whose content is not ciphertext is dropped', async () => {
  signInAs(bob);
  const wrap: NostrEvent = handMadeWrap({ rumor: rumorFrom(ALICE) });
  assert.equal(
    await unwrapChatMessage({ ...wrap, content: 'not encrypted' }),
    null,
  );
});

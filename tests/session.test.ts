/**
 * A public key is something to look through, never something to sign with.
 *
 * Browsing as a key must draw every screen for that key and refuse every
 * signature; loading a private key must end the browsing rather than sit
 * on top of it; and the signer - the one door every event goes through -
 * must stay shut while browsing even when a browser extension is standing
 * right there offering to open it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { type KvStore, setKvStore } from '../src/common/kv.js';
import {
  beginSignedInSession,
  endSession,
  getSession,
  getSessionPrivateKey,
  InvalidPublicKeyError,
  isReadOnlySession,
  parsePublicKey,
  ReadOnlySessionError,
  setSessionPrivateKeyFromRaw,
  startReadOnlySession,
} from '../src/common/session.js';
import {
  canWrite,
  hasSigner,
  NoSigningMethodError,
  signWithSession,
} from '../src/common/signer.js';
import type { PubkeyHex } from '../types/nostr';

/** The store, in memory, so each test starts from nobody. */
function freshStore(): void {
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
  endSession();
}

const SOMEONE: PubkeyHex = getPublicKey(generateSecretKey()) as PubkeyHex;
const NPUB: string = nip19.npubEncode(SOMEONE);
const NOTE = {
  kind: 1,
  created_at: 1_800_000_000,
  tags: [],
  content: 'hello',
  pubkey: SOMEONE,
};

test('public key: npub, nprofile, hex, and what is not one', () => {
  assert.equal(parsePublicKey(NPUB), SOMEONE);
  assert.equal(parsePublicKey(`  nostr:${NPUB}\n`), SOMEONE);
  assert.equal(parsePublicKey(SOMEONE.toUpperCase()), SOMEONE);
  assert.equal(
    parsePublicKey(nip19.nprofileEncode({ pubkey: SOMEONE, relays: [] })),
    SOMEONE,
  );
  // A secret pasted into the box that promised not to take one.
  assert.equal(parsePublicKey(nip19.nsecEncode(generateSecretKey())), null);
  assert.equal(parsePublicKey('npub1notreal'), null);
  assert.equal(parsePublicKey(''), null);
  assert.equal(parsePublicKey('a'.repeat(63)), null);
});

test('session: nobody, then browsing as someone, then nobody again', () => {
  freshStore();
  assert.deepEqual(getSession(), { kind: 'none', pubkey: null });

  const pubkey = startReadOnlySession(NPUB);
  assert.equal(pubkey, SOMEONE);
  assert.deepEqual(getSession(), { kind: 'read-only', pubkey: SOMEONE });
  assert.equal(isReadOnlySession(), true);

  endSession();
  assert.deepEqual(getSession(), { kind: 'none', pubkey: null });
});

test('session: something that is not a public key starts nothing', () => {
  freshStore();
  assert.throws(() => startReadOnlySession('hello'), InvalidPublicKeyError);
  assert.deepEqual(getSession(), { kind: 'none', pubkey: null });
});

test('session: browsing throws away a private key that was here', () => {
  freshStore();
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(generateSecretKey()));
  assert.equal(getSession().kind, 'signed-in');
  assert.ok(getSessionPrivateKey());

  startReadOnlySession(SOMEONE);
  assert.equal(getSessionPrivateKey(), null);
  assert.equal(hasSigner(), false);
});

test('session: loading a private key ends browsing rather than layering on it', () => {
  freshStore();
  startReadOnlySession(SOMEONE);
  const secret = generateSecretKey();
  const pubkey = setSessionPrivateKeyFromRaw(nip19.nsecEncode(secret));
  assert.deepEqual(getSession(), { kind: 'signed-in', pubkey });
  assert.notEqual(pubkey, SOMEONE);
  assert.ok(getSessionPrivateKey());
});

test('session: an extension sign-in ends browsing the same way', () => {
  freshStore();
  startReadOnlySession(SOMEONE);
  const other = getPublicKey(generateSecretKey()) as PubkeyHex;
  beginSignedInSession(other);
  assert.deepEqual(getSession(), { kind: 'signed-in', pubkey: other });
});

test('signer: a read-only session is refused before anything is tried', async () => {
  freshStore();
  startReadOnlySession(SOMEONE);
  // An extension is right there. It must not be asked.
  let asked = 0;
  (globalThis as { window?: unknown }).window = {
    nostr: {
      signEvent: async () => {
        asked += 1;
        return NOTE;
      },
    },
  };
  try {
    await assert.rejects(signWithSession(NOTE), ReadOnlySessionError);
    assert.equal(asked, 0);
    assert.equal(
      hasSigner(),
      true,
      'the extension exists; it is just off limits',
    );
  } finally {
    (globalThis as { window?: unknown }).window = undefined;
  }
});

test('signer: signed in with a key, the event is signed by it', async () => {
  freshStore();
  const secret = generateSecretKey();
  const pubkey = setSessionPrivateKeyFromRaw(nip19.nsecEncode(secret));
  const signed = await signWithSession({ ...NOTE, pubkey });
  assert.equal(signed.pubkey, pubkey);
  assert.equal(signed.sig.length, 128);
});

test('signer: nobody here means nothing to sign with', async () => {
  freshStore();
  await assert.rejects(signWithSession(NOTE), NoSigningMethodError);
});

test('canWrite: only a session that is not read-only and can sign', () => {
  freshStore();
  assert.equal(canWrite(), false, 'nobody');
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(generateSecretKey()));
  assert.equal(canWrite(), true, 'a key');
  startReadOnlySession(SOMEONE);
  assert.equal(canWrite(), false, 'browsing, key thrown away');
  (globalThis as { window?: unknown }).window = {
    nostr: { signEvent: async () => NOTE },
  };
  try {
    assert.equal(canWrite(), false, 'browsing, extension present');
    endSession();
    assert.equal(canWrite(), true, 'nobody browsing; the extension may sign');
  } finally {
    (globalThis as { window?: unknown }).window = undefined;
  }
});

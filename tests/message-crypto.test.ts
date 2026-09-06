import assert from 'node:assert/strict';
import test from 'node:test';
import type { AesPayload } from '../src/features/messages/message-crypto.js';
import {
  decryptJson,
  encryptJson,
  isEncryptedPayload,
} from '../src/features/messages/message-crypto.js';

interface Message {
  id: string;
  content: string;
}

const SECRET: string = 'meet me at the usual place';

/**
 * These tests run under Node, which has `crypto.subtle`, so every write here
 * takes the AES branch. The NIP-44 branch is the one the phone takes, and it
 * is reached by the absence of SubtleCrypto rather than by a flag - there is
 * nothing to pass in to select it.
 */
function aes(payload: unknown): AesPayload {
  assert.ok(payload && typeof payload === 'object');
  const candidate = payload as { v?: unknown };
  assert.equal(candidate.v, 1, 'expected the AES payload Node produces');
  return payload as AesPayload;
}

test('encryptJson round-trips through decryptJson', async () => {
  const messages: Message[] = [{ id: 'a', content: SECRET }];

  const payload = await encryptJson(messages);
  assert.ok(payload, 'expected a payload');
  assert.ok(isEncryptedPayload(payload));

  const restored = await decryptJson<Message[]>(payload);
  assert.deepEqual(restored, messages);
});

test('the stored payload does not contain the plaintext', async () => {
  const payload = await encryptJson([{ id: 'a', content: SECRET }]);
  assert.ok(payload);

  const bytes: Uint8Array = new Uint8Array(aes(payload).ct);
  const asText: string = new TextDecoder().decode(bytes);
  assert.ok(!asText.includes(SECRET));
  assert.ok(!asText.includes('usual'));
});

test('each write uses a fresh IV', async () => {
  const first = await encryptJson([{ id: 'a', content: SECRET }]);
  const second = await encryptJson([{ id: 'a', content: SECRET }]);
  assert.ok(first && second);

  assert.notDeepEqual(Array.from(aes(first).iv), Array.from(aes(second).iv));
  // Same plaintext, same key, different IV: the ciphertext must differ too.
  assert.notDeepEqual(
    Array.from(new Uint8Array(aes(first).ct)),
    Array.from(new Uint8Array(aes(second).ct)),
  );
});

test('tampered ciphertext is rejected rather than returned', async () => {
  const payload = await encryptJson([{ id: 'a', content: SECRET }]);
  assert.ok(payload);

  const bytes: Uint8Array = new Uint8Array(aes(payload).ct);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;

  const restored = await decryptJson<Message[]>({
    ...payload,
    ct: bytes.buffer,
  });
  assert.equal(restored, null);
});

test('a plaintext array is not mistaken for an encrypted payload', () => {
  assert.equal(isEncryptedPayload([{ id: 'a', content: SECRET }]), false);
  assert.equal(isEncryptedPayload(null), false);
});

// --- telling the two ciphers apart ------------------------------------------
//
// AES-GCM is used where `crypto.subtle` exists; React Native has none, and
// writes a NIP-44 blob instead. This check is the only thing between "read the
// cache" and "throw it away", and confusing the shapes hands the wrong bytes
// to the wrong decrypt call.

test('a NIP-44 payload is recognised', () => {
  assert.equal(isEncryptedPayload({ v: 2, ct: 'base64ish' }), true);
});

test('the two payload shapes are not confused for each other', () => {
  assert.equal(isEncryptedPayload({ v: 1, ct: 'base64ish' }), false);
  assert.equal(isEncryptedPayload({ v: 2, ct: new ArrayBuffer(16) }), false);
});

test('an AES payload missing its iv is rejected', () => {
  assert.equal(isEncryptedPayload({ v: 1, ct: new ArrayBuffer(16) }), false);
});

test('an unknown version is rejected', () => {
  // A blob from a future build. Refusing it costs a refetch; guessing at it
  // costs an exception on every launch.
  assert.equal(isEncryptedPayload({ v: 3, ct: 'whatever' }), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
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

  const bytes: Uint8Array = new Uint8Array(payload.ct);
  const asText: string = new TextDecoder().decode(bytes);
  assert.ok(!asText.includes(SECRET));
  assert.ok(!asText.includes('usual'));
});

test('each write uses a fresh IV', async () => {
  const first = await encryptJson([{ id: 'a', content: SECRET }]);
  const second = await encryptJson([{ id: 'a', content: SECRET }]);
  assert.ok(first && second);

  assert.notDeepEqual(Array.from(first.iv), Array.from(second.iv));
  // Same plaintext, same key, different IV: the ciphertext must differ too.
  assert.notDeepEqual(
    Array.from(new Uint8Array(first.ct)),
    Array.from(new Uint8Array(second.ct)),
  );
});

test('tampered ciphertext is rejected rather than returned', async () => {
  const payload = await encryptJson([{ id: 'a', content: SECRET }]);
  assert.ok(payload);

  const bytes: Uint8Array = new Uint8Array(payload.ct);
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

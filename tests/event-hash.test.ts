import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  setSha256,
  setSignatureCheck,
  verifiedEvent,
  verifySignature,
} from '../src/common/event-filter.js';
import type { NostrEvent } from '../types/nostr';

const signed = (content: string, tags: string[][] = []): NostrEvent =>
  finalizeEvent(
    { kind: 1, created_at: 1_700_000_000, tags, content },
    generateSecretKey(),
  ) as unknown as NostrEvent;

setSignatureCheck((signature, id, pubkey): boolean =>
  schnorr.verify(hexToBytes(signature), hexToBytes(id), hexToBytes(pubkey)),
);

// What the JVM does: a lone surrogate becomes `?`, where JavaScript's
// encoder writes U+FFFD.
let hashed: number = 0;
setSha256((text: string): string => {
  hashed += 1;
  const jvm: string = text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '?',
  );
  return createHash('sha256').update(jvm, 'utf8').digest('hex');
});

test('the installed hash gives nostr-tools ids, emoji and all', () => {
  hashed = 0;
  const event: NostrEvent = signed('夜の庭 🌙 "quoted" \\ \n', [
    ...Array.from({ length: 2400 }, (_, i): string[] => ['p', String(i)]),
  ]);
  assert.equal(verifySignature(event), true);
  assert.notEqual(verifiedEvent({ kinds: [1] }, signed('🌱')), null);
  assert.equal(hashed, 2);
});

test('edited content is refused with the installed hash', () => {
  const event: NostrEvent = { ...signed('hello'), content: 'edited' };
  assert.equal(verifySignature(event), false);
  assert.equal(verifiedEvent({ kinds: [1] }, event), null);
});

// JSON.stringify writes a lone surrogate as an escape, so both hashes see
// the same text; the guard is for an engine that does not.
test('a lone surrogate still gives the right id', () => {
  for (const content of ['a\ud800b', 'a\udc00', '\ud83c']) {
    assert.equal(
      verifySignature(signed(content)),
      true,
      JSON.stringify(content),
    );
  }
});

/**
 * The faster signature check the phone puts in place answers as nostr-tools
 * would: content that does not hash to the id is refused before the check
 * runs, and the check's answer is the verdict.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  setSignatureCheck,
  verifiedEvent,
  verifySignature,
} from '../src/common/event-filter.js';
import type { NostrEvent } from '../types/nostr';

const signed = (content: string): NostrEvent =>
  finalizeEvent(
    { kind: 1, created_at: 1_700_000_000, tags: [], content },
    generateSecretKey(),
  ) as unknown as NostrEvent;

let calls: number = 0;
setSignatureCheck((signature, id, pubkey): boolean => {
  calls += 1;
  return schnorr.verify(
    hexToBytes(signature),
    hexToBytes(id),
    hexToBytes(pubkey),
  );
});

test('a genuine event passes through the installed check', () => {
  calls = 0;
  assert.equal(verifySignature(signed('hello')), true);
  assert.equal(calls, 1);
  assert.notEqual(verifiedEvent({ kinds: [1] }, signed('again')), null);
});

test('edited content is refused before the check is asked', () => {
  calls = 0;
  const event: NostrEvent = { ...signed('hello'), content: 'edited' };
  assert.equal(verifySignature(event), false);
  assert.equal(verifiedEvent({ kinds: [1] }, event), null);
  assert.equal(calls, 0);
});

test('a signature from another key is refused', () => {
  const a: NostrEvent = signed('a');
  const b: NostrEvent = signed('a');
  assert.equal(verifySignature({ ...a, sig: b.sig }), false);
});

test('a signature with extra characters is refused without asking', () => {
  calls = 0;
  const event: NostrEvent = signed('padded');
  assert.equal(verifySignature({ ...event, sig: `0x${event.sig}` }), false);
  assert.equal(verifySignature({ ...event, sig: ` ${event.sig}` }), false);
  assert.equal(
    verifySignature({ ...event, sig: event.sig.toUpperCase() }),
    false,
  );
  assert.equal(calls, 0);
});

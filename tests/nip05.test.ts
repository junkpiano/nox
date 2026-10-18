/**
 * A NIP-05 address is shown only once its domain says it belongs to this
 * pubkey, and one lookup per address and pubkey serves every card asking.
 *
 * The domain's answer comes from a fetch handed to nostr-tools, so no
 * request leaves the process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { nip05 } from 'nostr-tools';
import {
  isNip05Identifier,
  resolveNip05,
  verifiedNip05,
} from '../src/common/nip05.js';
import type { PubkeyHex } from '../types/nostr';

const ALICE = 'a'.repeat(64) as PubkeyHex;
const MALLORY = 'b'.repeat(64) as PubkeyHex;

const asked: string[] = [];
nip05.useFetchImplementation(async (input: unknown): Promise<Response> => {
  const url: URL = new URL(String(input));
  asked.push(url.toString());
  if (url.hostname === 'down.example') {
    return new Response('', { status: 500 });
  }
  return new Response(JSON.stringify({ names: { alice: ALICE, _: MALLORY } }), {
    status: 200,
  });
});

test('an identifier is anything with an @ in it', () => {
  assert.equal(isNip05Identifier('alice@example.com'), true);
  assert.equal(isNip05Identifier('example.com'), false);
});

test('an address resolves to the pubkey its domain names', async () => {
  assert.equal(await resolveNip05('alice@example.com'), ALICE);
  assert.equal(await resolveNip05('nobody@example.com'), null);
  assert.equal(await resolveNip05('alice@down.example'), null);
  assert.equal(await resolveNip05('not an address'), null);
});

test('an address is shown only for the pubkey that owns it', async () => {
  assert.equal(
    await verifiedNip05(ALICE, ' alice@owned.example '),
    'alice@owned.example',
  );
  assert.equal(await verifiedNip05(MALLORY, 'alice@owned.example'), null);
});

test('nothing is asked for an empty or address-less claim', async () => {
  const before: number = asked.length;
  assert.equal(await verifiedNip05(ALICE, null), null);
  assert.equal(await verifiedNip05(ALICE, undefined), null);
  assert.equal(await verifiedNip05(ALICE, '   '), null);
  assert.equal(await verifiedNip05(ALICE, 'example.com'), null);
  assert.equal(asked.length, before);
});

test('the same address and pubkey are looked up once, whatever the case', async () => {
  const before: number = asked.length;
  const [first, second] = await Promise.all([
    verifiedNip05(ALICE, 'alice@once.example'),
    verifiedNip05(ALICE, 'ALICE@ONCE.EXAMPLE'),
  ]);
  assert.equal(asked.length, before + 1);
  assert.equal(first, 'alice@once.example');
  // The answer is remembered under the lowercased key, so the second
  // spelling gets the first one's text back.
  assert.equal(second, 'alice@once.example');
});

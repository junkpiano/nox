/**
 * Finding where to ask about zapping somebody.
 *
 * The two forms in a profile are a Lightning address (`lud16`, which looks
 * like an email address and is not one) and a bech32 LNURL (`lud06`). Getting
 * the well-known path wrong sends the request to a stranger's server, so this
 * is worth pinning down.
 *
 * The invoice checks are exercised end to end against a real endpoint rather
 * than here: a valid bolt11 cannot be written by hand, and one that is not
 * valid tests the error path only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLnurl, sha256Hex } from '../src/common/zap-request.js';
import type { NostrProfile } from '../types/nostr';

function profile(fields: Partial<NostrProfile>): NostrProfile {
  return fields as NostrProfile;
}

test('lnurl: a Lightning address becomes a well-known URL', () => {
  assert.equal(
    resolveLnurl(profile({ lud16: 'alice@example.com' })),
    'https://example.com/.well-known/lnurlp/alice',
  );
});

test('lnurl: surrounding whitespace does not change the host', () => {
  assert.equal(
    resolveLnurl(profile({ lud16: '  alice@example.com  ' })),
    'https://example.com/.well-known/lnurlp/alice',
  );
});

test('lnurl: no profile, and no address, resolve to nothing', () => {
  assert.equal(resolveLnurl(null), null);
  assert.equal(resolveLnurl(profile({})), null);
  assert.equal(resolveLnurl(profile({ lud16: '' })), null);
});

test('lnurl: an address without an @ is not an address', () => {
  // It would otherwise produce https://undefined/.well-known/...
  assert.equal(resolveLnurl(profile({ lud16: 'not-an-address' })), null);
});

test('lnurl: a malformed lud06 is refused rather than thrown', () => {
  // A profile field is a string a stranger chose. Failing to decode it must
  // not take down the card it is being rendered on.
  assert.equal(resolveLnurl(profile({ lud06: 'lnurl1nonsense' })), null);
});

test('lnurl: lud16 wins over lud06', () => {
  // Both are allowed to be present. The address is the newer, clearer form.
  const both = profile({
    lud16: 'alice@example.com',
    lud06: 'lnurl1nonsense',
  });
  assert.equal(
    resolveLnurl(both),
    'https://example.com/.well-known/lnurlp/alice',
  );
});

test('sha256: matches the known vector', () => {
  // The description hash in an invoice is compared against this. A hashing
  // function that is subtly wrong turns every zap into "does not match".
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('sha256: hashes the bytes, not the characters', () => {
  // JSON with non-ASCII in it is normal in a zap comment.
  assert.equal(sha256Hex('あ').length, 64);
  assert.notEqual(sha256Hex('あ'), sha256Hex('a'));
});

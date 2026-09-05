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

import type {
  ParsedBolt11Invoice,
  ZapPayInfo,
} from '../src/common/zap-request.js';
import {
  judgeInvoice,
  resolveLnurl,
  sha256Hex,
} from '../src/common/zap-request.js';
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

// --- judging an invoice ------------------------------------------------------
//
// The amount is what protects the money. The description hash is weaker than
// it looks: NIP-57 asks the server to commit to the zap request as received,
// and servers in the wild commit to a re-serialised copy - primal does, which
// is provable from outside this app. Refusing those refuses a large part of
// the network, so the two outcomes have to stay distinct: "wrong" throws,
// "could not verify" shows the invoice and pays nothing on its own.

const REQUEST_JSON = '{"kind":9734,"content":""}';
const PAY_INFO: ZapPayInfo = {
  callback: 'https://example.com/cb',
  minSendable: 1000,
  maxSendable: 100000000,
  metadata: '[["text/plain","sats"]]',
};

function invoice(fields: Partial<ParsedBolt11Invoice>): ParsedBolt11Invoice {
  return { amountSats: 21, ...fields };
}

test('invoice: a wrong amount is refused outright', () => {
  // The only thing here that can cost somebody money they did not agree to.
  assert.throws(
    () =>
      judgeInvoice(invoice({ amountSats: 2100 }), 21, PAY_INFO, REQUEST_JSON),
    /amount does not match/,
  );
});

test('invoice: a hash committing to the zap request is payable', () => {
  const parsed = invoice({ purposeCommitHash: sha256Hex(REQUEST_JSON) });
  assert.deepEqual(judgeInvoice(parsed, 21, PAY_INFO, REQUEST_JSON), {
    canAutoPay: true,
  });
});

test('invoice: a hash committing to the LNURL metadata is payable', () => {
  const parsed = invoice({
    purposeCommitHash: sha256Hex(PAY_INFO.metadata as string),
  });
  assert.equal(
    judgeInvoice(parsed, 21, PAY_INFO, REQUEST_JSON).canAutoPay,
    true,
  );
});

test('invoice: an unmatched hash is not paid, and not refused', () => {
  // The case that made zapping impossible: this used to throw, so anybody
  // whose server re-serialises the request could not be zapped at all.
  const parsed = invoice({ purposeCommitHash: 'f'.repeat(64) });
  const judged = judgeInvoice(parsed, 21, PAY_INFO, REQUEST_JSON);
  assert.equal(judged.canAutoPay, false);
  assert.match(judged.warning ?? '', /by hand/);
});

test('invoice: a matching plain description is payable', () => {
  const parsed = invoice({ description: REQUEST_JSON });
  assert.equal(
    judgeInvoice(parsed, 21, PAY_INFO, REQUEST_JSON).canAutoPay,
    true,
  );
});

test('invoice: a differing plain description is not paid automatically', () => {
  const parsed = invoice({ description: 'something else entirely' });
  assert.equal(
    judgeInvoice(parsed, 21, PAY_INFO, REQUEST_JSON).canAutoPay,
    false,
  );
});

test('invoice: no description at all is payable on the amount alone', () => {
  // There is nothing to disagree with, and the amount already matched.
  assert.equal(
    judgeInvoice(invoice({}), 21, PAY_INFO, REQUEST_JSON).canAutoPay,
    true,
  );
});

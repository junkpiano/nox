/**
 * NIP-57 from the LNURL endpoint to a checked invoice.
 *
 * The recipient's server is played by a fetch installed through the
 * cross-origin seam, so nothing leaves the process. Invoices are built here
 * with a correct bech32 checksum and a zeroed signature: parsing never checks
 * the signature, so a structurally valid invoice is enough to exercise the
 * tagged-field walk end to end.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bech32 } from '@scure/base';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { setCrossOriginFetch } from '../src/common/native-http.js';
import {
  fetchZapPayInfo,
  judgeInvoice,
  parseBolt11Invoice,
  requestZapInvoice,
  resolveLnurl,
  sha256Hex,
  validateInvoiceForZap,
  type ZapInvoiceRequest,
  type ZapPayInfo,
} from '../src/common/zap-request.js';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../types/nostr';

const sender: Uint8Array = generateSecretKey();
const SENDER: PubkeyHex = getPublicKey(sender) as PubkeyHex;
const RECIPIENT: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
const LUD16: NostrProfile = { lud16: 'alice@zap.example.com' } as NostrProfile;
const WELL_KNOWN: string = 'https://zap.example.com/.well-known/lnurlp/alice';

// --- building invoices -------------------------------------------------------

function field(type: number, bytes: Uint8Array): number[] {
  const words: number[] = bech32.toWords(bytes);
  return [type, words.length >> 5, words.length & 31, ...words];
}

/** A bolt11 for `amount` (in bolt11 units, e.g. "210n") with these fields. */
function bolt11(
  amount: string,
  fields: number[][],
  tail: number[] = [],
): string {
  const timestamp: number[] = [0, 0, 0, 0, 0, 0, 1];
  const signature: number[] = new Array<number>(104).fill(0);
  return bech32.encode(
    `lnbc${amount}`,
    [...timestamp, ...fields.flat(), ...tail, ...signature],
    5000,
  );
}

function descriptionField(text: string): number[] {
  return field(13, new TextEncoder().encode(text));
}

function hashField(hex: string): number[] {
  return field(23, Uint8Array.from(Buffer.from(hex, 'hex')));
}

test('an invoice yields its amount, description and description hash', () => {
  const hash: string = sha256Hex('anything');
  const parsed = parseBolt11Invoice(
    bolt11('210n', [
      // A payment hash first, which the walk must skip by length.
      field(1, new Uint8Array(32).fill(7)),
      descriptionField('zap for alice'),
      hashField(hash),
    ]),
  );
  assert.deepEqual(parsed, {
    amountSats: 21,
    description: 'zap for alice',
    purposeCommitHash: hash,
  });
});

test('a tagged field longer than what is left stops the walk instead of throwing', () => {
  // Claims 31 * 32 + 31 words of data, far past the end.
  const parsed = parseBolt11Invoice(
    bolt11('210n', [descriptionField('kept')], [13, 31, 31, 1, 2, 3]),
  );
  assert.equal(parsed.description, 'kept');
  assert.equal(parsed.amountSats, 21);
});

test('an invoice too short to carry a signature is refused', () => {
  const short: string = bech32.encode('lnbc210n', new Array(50).fill(0), 5000);
  assert.throws(() => parseBolt11Invoice(short), /too short/);
});

test('a string that is not bech32 is refused by the parser', () => {
  assert.throws(() => parseBolt11Invoice('lnbc1notaninvoice'));
});

test('an invoice whose description is the zap request itself is payable', () => {
  const request: string = '{"kind":9734}';
  const payInfo: ZapPayInfo = {
    callback: 'https://zap.example.com/cb',
    minSendable: 1000,
    maxSendable: 1_000_000,
    metadata: '[["text/plain","hi"]]',
  };
  assert.deepEqual(
    validateInvoiceForZap(
      bolt11('210n', [descriptionField(request)]),
      21,
      payInfo,
      request,
    ),
    { canAutoPay: true },
  );
  // The LNURL metadata as the description is acceptable too.
  assert.equal(
    judgeInvoice(
      { amountSats: 21, description: payInfo.metadata as string },
      21,
      payInfo,
      request,
    ).canAutoPay,
    true,
  );
});

test('an invoice whose description is something else is shown but not paid automatically', () => {
  const judged = judgeInvoice(
    { amountSats: 21, description: 'something else' },
    21,
    { callback: 'x', minSendable: 1, maxSendable: 2 },
    '{"kind":9734}',
  );
  assert.equal(judged.canAutoPay, false);
  assert.match(judged.warning ?? '', /description differs/);
});

test('an invoice with neither a description nor a hash is payable on its amount alone', () => {
  assert.deepEqual(
    judgeInvoice(
      { amountSats: 21 },
      21,
      { callback: 'x', minSendable: 1, maxSendable: 2 },
      '{}',
    ),
    { canAutoPay: true },
  );
});

test('a bech32 lud06 decodes to the URL it encodes', () => {
  const lud06: string = bech32.encode(
    'lnurl',
    bech32.toWords(new TextEncoder().encode(WELL_KNOWN)),
    1000,
  );
  assert.equal(
    resolveLnurl({ lud06: ` ${lud06.toUpperCase()} ` } as NostrProfile),
    WELL_KNOWN,
  );
});

test('a Lightning address with nothing before the @ is not an address', () => {
  assert.equal(resolveLnurl({ lud16: '@example.com' } as NostrProfile), null);
});

// --- the recipient's server -------------------------------------------------

type Server = (url: URL) => Response;

const requested: URL[] = [];

function serve(server: Server): void {
  requested.length = 0;
  setCrossOriginFetch(async (input: string): Promise<Response> => {
    const url: URL = new URL(input);
    requested.push(url);
    return server(url);
  });
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: { 'content-type': 'application/json' },
  });
}

const PAY_INFO: ZapPayInfo = {
  callback: 'https://zap.example.com/callback?token=1',
  minSendable: 1_000,
  maxSendable: 100_000,
  metadata: '[["text/plain","Zap alice"]]',
  commentAllowed: 10,
  allowsNostr: true,
  nostrPubkey: 'c'.repeat(64),
};

test('pay info is fetched from the well-known URL and returned as given', async () => {
  serve((): Response => json(PAY_INFO));
  assert.deepEqual(await fetchZapPayInfo(LUD16), PAY_INFO);
  assert.equal(requested[0]?.toString(), WELL_KNOWN);
});

test('a profile without a Lightning address cannot be zapped', async () => {
  serve((): Response => json(PAY_INFO));
  await assert.rejects(
    fetchZapPayInfo(null),
    /does not have a Lightning address/,
  );
  assert.equal(requested.length, 0);
});

test('a Lightning address on a private host is never fetched', async () => {
  serve((): Response => json(PAY_INFO));
  await assert.rejects(
    fetchZapPayInfo({ lud16: 'alice@192.168.1.1' } as NostrProfile),
    /somewhere this app will not go/,
  );
  assert.equal(requested.length, 0);
});

test('a pay endpoint that fails, errors or lacks NIP-57 support is refused with a reason', async () => {
  serve((): Response => json({}, 404));
  await assert.rejects(fetchZapPayInfo(LUD16), /404 Not Found/);

  serve((): Response => json({ status: 'ERROR', reason: 'no such user' }));
  await assert.rejects(fetchZapPayInfo(LUD16), /no such user/);

  serve((): Response => json({ status: 'ERROR' }));
  await assert.rejects(fetchZapPayInfo(LUD16), /returned an error/);

  serve((): Response => json({ ...PAY_INFO, allowsNostr: false }));
  await assert.rejects(fetchZapPayInfo(LUD16), /does not support NIP-57/);

  serve((): Response => json({ ...PAY_INFO, nostrPubkey: undefined }));
  await assert.rejects(fetchZapPayInfo(LUD16), /does not support NIP-57/);
});

test('amount limits that make no sense are refused', async () => {
  for (const limits of [
    { minSendable: 0, maxSendable: 1000 },
    { minSendable: 5000, maxSendable: 1000 },
    { minSendable: 'x', maxSendable: 1000 },
  ]) {
    serve((): Response => json({ ...PAY_INFO, ...limits }));
    await assert.rejects(fetchZapPayInfo(LUD16), /invalid amount limits/);
  }
});

// --- the zap request and the invoice ---------------------------------------

function zapRequest(
  overrides: Partial<ZapInvoiceRequest> = {},
): ZapInvoiceRequest {
  return {
    senderPubkey: SENDER,
    recipientPubkey: RECIPIENT,
    recipientProfile: LUD16,
    amountSats: 21,
    comment: '',
    relays: ['wss://relay.example.com'],
    sign: async (event: Omit<NostrEvent, 'id' | 'sig'>): Promise<NostrEvent> =>
      finalizeEvent(event, sender) as NostrEvent,
    ...overrides,
  };
}

/** Pay info at the well-known URL; the callback answers with `invoice`. */
function zapServer(invoice: (url: URL) => unknown, payInfo = PAY_INFO): void {
  serve(
    (url: URL): Response =>
      url.pathname.startsWith('/.well-known/')
        ? json(payInfo)
        : json(invoice(url)),
  );
}

test('a zap request is signed, sent to the callback, and the invoice it buys is checked', async () => {
  zapServer((url: URL): unknown => ({
    // A server that commits to exactly the request it received.
    pr: bolt11('210n', [
      hashField(sha256Hex(url.searchParams.get('nostr') ?? '')),
    ]),
  }));
  const zap = await requestZapInvoice(zapRequest({ comment: '  thanks  ' }));

  const callback: URL | undefined = requested[1];
  assert.ok(callback);
  assert.equal(
    callback.origin + callback.pathname,
    'https://zap.example.com/callback',
  );
  assert.equal(callback.searchParams.get('token'), '1');
  assert.equal(callback.searchParams.get('amount'), '21000');
  assert.equal(callback.searchParams.get('comment'), 'thanks');
  assert.equal(callback.searchParams.get('nostr'), zap.zapRequestJson);

  const signed = JSON.parse(zap.zapRequestJson) as NostrEvent;
  assert.equal(signed.kind, 9734);
  assert.equal(signed.pubkey, SENDER);
  assert.equal(signed.content, 'thanks');
  assert.deepEqual(
    signed.tags.find((tag: string[]): boolean => tag[0] === 'p'),
    ['p', RECIPIENT],
  );
  assert.deepEqual(
    signed.tags.find((tag: string[]): boolean => tag[0] === 'amount'),
    ['amount', '21000'],
  );
  assert.deepEqual(
    signed.tags.find((tag: string[]): boolean => tag[0] === 'relays'),
    ['relays', 'wss://relay.example.com'],
  );
  assert.deepEqual(zap.validation, { canAutoPay: true });
  assert.deepEqual(zap.payInfo, PAY_INFO);
});

test('zapping a post tags the post, and no comment means no comment parameter', async () => {
  zapServer((): unknown => ({ pr: bolt11('210n', [descriptionField('x')]) }));
  const post: NostrEvent = finalizeEvent(
    { kind: 1, created_at: 1, tags: [], content: 'a post' },
    generateSecretKey(),
  ) as NostrEvent;
  const zap = await requestZapInvoice(zapRequest({ event: post }));

  assert.equal(requested[1]?.searchParams.has('comment'), false);
  const signed = JSON.parse(zap.zapRequestJson) as NostrEvent;
  assert.deepEqual(
    signed.tags.find((tag: string[]): boolean => tag[0] === 'e'),
    ['e', post.id],
  );
  // The description is not the request: shown, not auto-paid.
  assert.equal(zap.validation.canAutoPay, false);
});

test('an invoice for a different amount than asked is refused', async () => {
  zapServer((): unknown => ({ pr: bolt11('2100n', [descriptionField('x')]) }));
  await assert.rejects(
    requestZapInvoice(zapRequest()),
    /amount does not match/,
  );
});

test('amounts outside what the endpoint accepts are refused before signing', async () => {
  let signed: boolean = false;
  zapServer((): unknown => ({}));
  await assert.rejects(
    requestZapInvoice(
      zapRequest({
        amountSats: 101,
        sign: async (): Promise<NostrEvent> => {
          signed = true;
          throw new Error('unreachable');
        },
      }),
    ),
    /between 1 and 100 sats/,
  );
  await assert.rejects(
    requestZapInvoice(zapRequest({ amountSats: 0 })),
    /between 1 and 100 sats/,
  );
  assert.equal(signed, false);
});

test('a comment is refused where none is accepted, or when it is over the limit', async () => {
  zapServer((): unknown => ({}), { ...PAY_INFO, commentAllowed: 0 });
  await assert.rejects(
    requestZapInvoice(zapRequest({ comment: 'hi' })),
    /does not accept zap comments/,
  );

  zapServer((): unknown => ({}), { ...PAY_INFO, commentAllowed: 3 });
  await assert.rejects(
    requestZapInvoice(zapRequest({ comment: 'four' })),
    /Comment is too long. Limit: 3/,
  );
});

test('a callback that fails, errors, or returns no invoice is reported', async () => {
  serve(
    (url: URL): Response =>
      url.pathname.startsWith('/.well-known/') ? json(PAY_INFO) : json({}, 404),
  );
  await assert.rejects(
    requestZapInvoice(zapRequest()),
    /Failed to create invoice: 404/,
  );

  zapServer((): unknown => ({ status: 'ERROR', reason: 'node offline' }));
  await assert.rejects(requestZapInvoice(zapRequest()), /node offline/);

  zapServer((): unknown => ({ status: 'ERROR' }));
  await assert.rejects(
    requestZapInvoice(zapRequest()),
    /invoice request failed/,
  );

  zapServer((): unknown => ({}));
  await assert.rejects(
    requestZapInvoice(zapRequest()),
    /did not return a Lightning invoice/,
  );
});

test('a callback on a private host is never called', async () => {
  zapServer((): unknown => ({}), {
    ...PAY_INFO,
    callback: 'http://127.0.0.1/callback',
  });
  await assert.rejects(
    requestZapInvoice(zapRequest()),
    /Zap endpoint points somewhere this app will not go/,
  );
  assert.equal(requested.length, 1);
});

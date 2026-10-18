/**
 * Uploading an image: a NIP-98 authorisation signed by the viewer for this
 * exact URL and method, and a URL read out of whichever answer shape the
 * server gives.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { uploadImage } from '../src/common/image-upload.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

// The module looks for a browser extension on `window`; this one has none.
(globalThis as unknown as { window: object }).window = {};

const key: Uint8Array = generateSecretKey();
const pubkey: PubkeyHex = getPublicKey(key) as PubkeyHex;
setSessionPrivateKeyFromRaw(Buffer.from(key).toString('hex'));

const file: File = new File([new Uint8Array([1, 2, 3])], 'cat.png', {
  type: 'image/png',
});
const noKey = (): Uint8Array | null => null;

interface Seen {
  url: string;
  init: RequestInit;
}

/** Answers every request with `body` and `status`, keeping what was asked. */
function serve(body: unknown, status: number = 200): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status },
    );
  };
  return seen;
}

test('the upload carries a NIP-98 event signed for this URL and method, and the file', async () => {
  const seen: Seen[] = serve({
    nip94_event: { tags: [['url', 'https://cdn.example/cat.png']] },
  });
  const result = await uploadImage(file, pubkey, noKey);
  assert.deepEqual(result, { url: 'https://cdn.example/cat.png' });

  const request: Seen | undefined = seen[0];
  assert.ok(request);
  assert.equal(request.url, 'https://nostrcheck.me/api/v2/media');
  assert.equal(request.init.method, 'POST');
  const header: string =
    (request.init.headers as Record<string, string>).Authorization ?? '';
  assert.match(header, /^Nostr /);
  const auth: NostrEvent = JSON.parse(atob(header.slice('Nostr '.length)));
  assert.equal(auth.kind, 27235);
  assert.equal(auth.pubkey, pubkey);
  assert.equal(auth.content, '');
  assert.deepEqual(auth.tags, [
    ['u', 'https://nostrcheck.me/api/v2/media'],
    ['method', 'POST'],
  ]);
  assert.ok(verifyEvent(auth as unknown as Parameters<typeof verifyEvent>[0]));
  const body = request.init.body as FormData;
  assert.equal(body.get('uploadtype'), 'media');
  assert.equal((body.get('file') as File).name, 'cat.png');
});

test('a bare url field is accepted when there is no NIP-94 URL', async () => {
  serve({ url: 'https://cdn.example/direct.png' });
  assert.deepEqual(await uploadImage(file, pubkey, noKey), {
    url: 'https://cdn.example/direct.png',
  });
  serve({
    nip94_event: { tags: [['x', 'hash']] },
    url: 'https://cdn.example/fallback.png',
  });
  assert.deepEqual(await uploadImage(file, pubkey, noKey), {
    url: 'https://cdn.example/fallback.png',
  });
});

test('an answer without a URL is an error', async () => {
  serve({ status: 'success' });
  await assert.rejects(uploadImage(file, pubkey, noKey), /no URL in response/);
  serve({ nip94_event: {}, url: 42 });
  await assert.rejects(uploadImage(file, pubkey, noKey), /no URL in response/);
});

test('a refused upload reports the status and what the server said', async () => {
  serve('too large', 413);
  await assert.rejects(
    uploadImage(file, pubkey, noKey),
    /Upload failed: 413 too large/,
  );
});

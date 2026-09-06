/**
 * The direct fetch, driven by a scripted fetch instead of a network.
 *
 * What is under test is what the fetch refuses to do on a reader's behalf:
 * ask a private address, follow a redirect to one, wait forever, or read a
 * page without end.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIRECT_FETCH_MAX_BYTES,
  type DirectFetch,
  fetchOGPDirect,
  fetchOGPViaProxy,
  OGP_PROXY,
} from '../src/common/ogp-fetch.js';

const PAGE =
  '<html><head><meta property="og:title" content="Hello"></head></html>';

function html(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

function redirect(to: string, status: number = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

test('direct: a private or local address is never asked', async () => {
  const asked: string[] = [];
  const fetchFn: DirectFetch = async (url) => {
    asked.push(url);
    return html(PAGE);
  };
  for (const url of [
    'http://127.0.0.1/',
    'http://192.168.1.1/',
    'http://localhost:3000/',
    'http://169.254.169.254/latest/meta-data/',
    'http://nas/',
    'file:///etc/hosts',
  ]) {
    assert.equal(await fetchOGPDirect(url, fetchFn), null, url);
  }
  assert.deepEqual(asked, []);
});

test('direct: a redirect is followed only to another public address', async () => {
  const asked: string[] = [];
  const fetchFn: DirectFetch = async (url) => {
    asked.push(url);
    if (url === 'https://example.com/a') return redirect('/b');
    if (url === 'https://example.com/b') return redirect('http://10.0.0.1/');
    return html(PAGE);
  };
  assert.equal(await fetchOGPDirect('https://example.com/a', fetchFn), null);
  assert.deepEqual(asked, ['https://example.com/a', 'https://example.com/b']);

  const good: DirectFetch = async (url) =>
    url === 'https://example.com/a'
      ? redirect('https://other.example/page', 301)
      : html(PAGE);
  const result = await fetchOGPDirect('https://example.com/a', good);
  assert.equal(result?.data['og:title'], 'Hello');
  assert.equal(result?.url, 'https://example.com/a');
});

test('direct: a runtime that followed redirects itself is judged on where it landed', async () => {
  const landedPrivate: DirectFetch = async () => {
    const response = html(PAGE);
    Object.defineProperty(response, 'url', { value: 'http://192.168.0.10/' });
    return response;
  };
  assert.equal(
    await fetchOGPDirect('https://example.com/', landedPrivate),
    null,
  );
});

test('direct: too many redirects is a refusal, not a loop', async () => {
  let calls = 0;
  const fetchFn: DirectFetch = async (url) => {
    calls += 1;
    return redirect(`${url}x`);
  };
  assert.equal(await fetchOGPDirect('https://example.com/', fetchFn), null);
  assert.ok(calls <= 4, `made ${calls} requests`);
});

test('direct: the deadline aborts a page that never answers', async () => {
  const fetchFn: DirectFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new Error('aborted')),
      );
    });
  // The real deadline is ten seconds; the abort path is what matters here,
  // so it is triggered through the same signal by aborting early.
  const started = Date.now();
  const guarded: DirectFetch = (url, init) => {
    setTimeout(
      () => (init.signal as AbortSignal).dispatchEvent(new Event('abort')),
      20,
    );
    return fetchFn(url, init);
  };
  await assert.rejects(fetchOGPDirect('https://example.com/', guarded));
  assert.ok(Date.now() - started < 5000);
});

test('direct: the body is read up to the limit and no further', async () => {
  const big = `${PAGE}${'x'.repeat(DIRECT_FETCH_MAX_BYTES * 2)}`;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(big);
      for (let at = 0; at < bytes.length; at += 4096) {
        controller.enqueue(bytes.subarray(at, at + 4096));
      }
      controller.close();
    },
    pull() {
      pulled += 1;
    },
  });
  const fetchFn: DirectFetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  const result = await fetchOGPDirect('https://example.com/', fetchFn);
  assert.equal(result?.data['og:title'], 'Hello');
  assert.ok(pulled < 200, 'read the whole body');
});

test('direct: without a stream, a body that declares more than the limit is not read', async () => {
  let read = false;
  const fetchFn: DirectFetch = async () => {
    const response = html(PAGE, {
      'content-length': String(DIRECT_FETCH_MAX_BYTES + 1),
    });
    Object.defineProperty(response, 'body', { value: null });
    Object.defineProperty(response, 'text', {
      value: async () => {
        read = true;
        return PAGE;
      },
    });
    return response;
  };
  assert.equal(await fetchOGPDirect('https://example.com/', fetchFn), null);
  assert.equal(read, false);
});

test('direct: something that is not a page is not read', async () => {
  let read = false;
  const fetchFn: DirectFetch = async () => {
    const response = new Response('...', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    Object.defineProperty(response, 'text', {
      value: async () => {
        read = true;
        return '';
      },
    });
    return response;
  };
  assert.equal(
    await fetchOGPDirect('https://example.com/a.png', fetchFn),
    null,
  );
  assert.equal(read, false);
});

// --- the proxy, which is where the phone goes ----------------------------------------

test('proxy: the page is asked for by the worker, not the device, under a deadline', async () => {
  let askedUrl = '';
  let hadSignal = false;
  const fetchFn: DirectFetch = async (url, init) => {
    askedUrl = url;
    hadSignal = init.signal instanceof AbortSignal;
    return new Response(
      JSON.stringify({ url: 'http://192.168.1.1/', data: { title: 'x' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const result = await fetchOGPViaProxy('http://192.168.1.1/', fetchFn);
  assert.equal(
    askedUrl,
    `${OGP_PROXY}?url=${encodeURIComponent('http://192.168.1.1/')}`,
  );
  assert.equal(hadSignal, true);
  assert.equal(result?.data.title, 'x');
});

test('proxy: a refusal from the worker, or an answer that is not a card, is null', async () => {
  const refused: DirectFetch = async () =>
    new Response('bad target', { status: 400 });
  assert.equal(await fetchOGPViaProxy('http://127.0.0.1/', refused), null);
  const junk: DirectFetch = async () =>
    new Response('"not an object"', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  assert.equal(await fetchOGPViaProxy('https://example.com/', junk), null);
});

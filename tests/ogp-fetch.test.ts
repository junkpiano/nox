/**
 * Link cards are always read by the proxy worker, never by the reader's own
 * device: a URL from somebody else's post must not reach the reader's network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCrossOriginFetch } from '../src/common/native-http.js';
import {
  fetchOGP,
  fetchOGPViaProxy,
  OGP_PROXY,
  type ProxyFetch,
} from '../src/common/ogp-fetch.js';

test('proxy: the page is asked for by the worker, not the device, under a deadline', async () => {
  let askedUrl = '';
  let hadSignal = false;
  const fetchFn: ProxyFetch = async (url, init) => {
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
  const refused: ProxyFetch = async () =>
    new Response('bad target', { status: 400 });
  assert.equal(await fetchOGPViaProxy('http://127.0.0.1/', refused), null);
  const junk: ProxyFetch = async () =>
    new Response('"not an object"', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  assert.equal(await fetchOGPViaProxy('https://example.com/', junk), null);
});

test('the desktop app asks the proxy too, through its own HTTP client', async () => {
  const asked: string[] = [];
  const target = 'http://x.192.168.1.1.nip.io/';
  (globalThis as { isTauri?: boolean }).isTauri = true;
  setCrossOriginFetch(async (url: string): Promise<Response> => {
    asked.push(url);
    return new Response(JSON.stringify({ url: target, data: { title: 'x' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const result = await fetchOGP(target);
    assert.deepEqual(asked, [`${OGP_PROXY}?url=${encodeURIComponent(target)}`]);
    assert.equal(result?.data.title, 'x');
  } finally {
    setCrossOriginFetch(null);
    delete (globalThis as { isTauri?: boolean }).isTauri;
  }
});

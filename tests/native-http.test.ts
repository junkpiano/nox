/**
 * The desktop app's fetch, through the real Tauri HTTP plugin with the IPC
 * underneath it played by a stub.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPublic } from '../src/common/public-fetch.js';

test('on desktop a redirect comes back to the caller, which refuses one into the local network', async () => {
  const sent: Record<string, unknown>[] = [];
  const g = globalThis as Record<string, unknown>;
  g.isTauri = true;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (
        command: string,
        _args: unknown,
        options?: { headers?: Record<string, string> },
      ): Promise<unknown> => {
        if (command === 'plugin:http|fetch') {
          const config: string = options?.headers?.['client-config'] ?? '{}';
          sent.push(JSON.parse(decodeURIComponent(config)));
          return 1;
        }
        if (command === 'plugin:http|fetch_send') {
          return {
            status: 302,
            statusText: 'Found',
            url: 'https://pay.example.com/.well-known/lnurlp/bob',
            headers: [['location', 'https://192.168.1.1/']],
            rid: 2,
          };
        }
        return null;
      },
    },
  };
  try {
    const fetched = await fetchPublic(
      'https://pay.example.com/.well-known/lnurlp/bob',
    );
    assert.equal(fetched, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.maxRedirections, 0);
  } finally {
    delete g.isTauri;
    delete g.window;
  }
});

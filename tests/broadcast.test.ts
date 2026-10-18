/**
 * Broadcast resends the viewer's own recent posts from the cache. What it
 * refuses to start without is testable here; the cache itself is IndexedDB,
 * which Node does not have, so the cache always reads as empty.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { broadcastRecentPosts } from '../src/features/broadcast/broadcast.js';

test('without localStorage at all, broadcast fails with a ReferenceError', async () => {
  // Documents current behaviour: this module reads `localStorage` directly
  // rather than through the kv seam (`kvGet`), so where there is none - the
  // React Native runtime - it throws instead of saying sign-in is required.
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'] }),
    ReferenceError,
  );
});

test('broadcast asks for a sign-in, relays, and posts, in that order', async () => {
  const stored: Map<string, string> = new Map();
  (
    globalThis as unknown as { localStorage: Pick<Storage, 'getItem'> }
  ).localStorage = {
    getItem: (key: string): string | null => stored.get(key) ?? null,
  };
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'] }),
    /Sign-in required/,
  );
  stored.set('nostr_pubkey', 'a'.repeat(64));
  await assert.rejects(
    broadcastRecentPosts({ relays: ['', ''] }),
    /No relays configured/,
  );
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'], limit: 5 }),
    /No recent posts found in cache/,
  );
});

/**
 * Broadcast resends the viewer's own recent posts from the cache. What it
 * refuses to start without is testable here; the cache itself is IndexedDB,
 * which Node does not have, so the cache always reads as empty.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { kvSet } from '../src/common/kv.js';
import { broadcastRecentPosts } from '../src/features/broadcast/broadcast.js';

test('without localStorage at all - as on the phone - broadcast asks for a sign-in', async () => {
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'] }),
    /Sign-in required/,
  );
});

test('broadcast asks for a sign-in, relays, and posts, in that order', async () => {
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'] }),
    /Sign-in required/,
  );
  kvSet('nostr_pubkey', 'a'.repeat(64));
  await assert.rejects(
    broadcastRecentPosts({ relays: ['', ''] }),
    /No relays configured/,
  );
  await assert.rejects(
    broadcastRecentPosts({ relays: ['wss://a.example'], limit: 5 }),
    /No recent posts found in cache/,
  );
});

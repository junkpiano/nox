import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTimelineRemovalTargets } from '../src/common/deletion-targets.js';
import type { PubkeyHex } from '../types/nostr';

test('computeTimelineRemovalTargets includes global + user timeline always', () => {
  const author: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
  const targets = computeTimelineRemovalTargets({
    viewerPubkey: null,
    authorPubkey: author,
  });

  assert.equal(targets[0]?.type, 'global');
  assert.equal(targets[1]?.type, 'user');
  assert.equal((targets[1] as any).pubkey, author);
});

test('computeTimelineRemovalTargets includes home timeline when viewerPubkey is present', () => {
  const viewer: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
  const author: PubkeyHex = 'c'.repeat(64) as PubkeyHex;
  const targets = computeTimelineRemovalTargets({
    viewerPubkey: viewer,
    authorPubkey: author,
  });

  assert.deepEqual(targets, [
    { type: 'global' },
    { type: 'home', pubkey: viewer },
    { type: 'user', pubkey: author },
  ]);
});

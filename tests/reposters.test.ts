/**
 * Who reposted a post: one row per person, most recent first, with reposts
 * of other posts and withdrawn reposts left out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { fetchReposters } from '../src/common/reaction-summary.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import { fakeRelay, signed } from './fake-relay.js';

const target: string = 'a'.repeat(64);
const other: string = 'b'.repeat(64);
const mika: Uint8Array = generateSecretKey();
const ken: Uint8Array = generateSecretKey();
const sora: Uint8Array = generateSecretKey();

const repostOf = (key: Uint8Array, id: string, at: number) =>
  signed(key, {
    kind: 6,
    tags: [
      ['e', id],
      ['p', 'c'.repeat(64)],
    ],
    created_at: at,
  });

test('reposters are listed once each, most recent first, withdrawals left out', async () => {
  const kept = repostOf(mika, target, 100);
  const later = repostOf(ken, target, 300);
  const withdrawn = repostOf(sora, target, 200);
  fakeRelay('wss://reposts.example', {
    events: [
      kept,
      later,
      withdrawn,
      repostOf(mika, other, 400),
      signed(sora, { kind: 5, tags: [['e', withdrawn.id]], created_at: 250 }),
    ],
  });
  const rows = await fetchReposters(target, ['wss://reposts.example']);
  assert.deepEqual(
    rows.map((row) => [row.pubkey, row.count]),
    [
      [getPublicKey(ken), 1],
      [getPublicKey(mika), 1],
    ],
  );
});

test('no relays is nobody; silence from every relay is an error', async () => {
  assert.deepEqual(await fetchReposters(target, []), []);
  fakeRelay('wss://down.reposts', { refuses: true });
  await assert.rejects(
    fetchReposters(target, ['wss://down.reposts']),
    NoRelayAnsweredError,
  );
});

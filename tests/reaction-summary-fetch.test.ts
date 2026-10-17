/**
 * Reaction summaries for a screenful of posts in one question, with
 * withdrawals asked about second - and silence from every relay reported
 * as silence, not as "nobody reacted".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey } from 'nostr-tools';
import {
  fetchReactionSummaries,
  fetchReactionSummary,
} from '../src/common/reaction-summary.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import { fakeRelay, signed } from './fake-relay.js';

const one: Uint8Array = generateSecretKey();
const two: Uint8Array = generateSecretKey();
const POST: string = 'a'.repeat(64);
const OTHER: string = 'b'.repeat(64);
const QUIET: string = 'c'.repeat(64);

const react = (key: Uint8Array, target: string, content: string) =>
  signed(key, { kind: 7, content, tags: [['e', target]] });

test('no posts or no relays asks nothing', async () => {
  assert.equal((await fetchReactionSummaries([], ['wss://x'])).size, 0);
  assert.equal((await fetchReactionSummaries([POST], [])).size, 0);
});

test('every relay silent is an error rather than an empty summary', async () => {
  fakeRelay('wss://down.summary', { refuses: true });
  await assert.rejects(
    fetchReactionSummaries([POST], ['wss://down.summary']),
    NoRelayAnsweredError,
  );
});

test('posts nobody reacted to have no summary', async () => {
  fakeRelay('wss://empty.summary');
  assert.equal(
    (await fetchReactionSummaries([POST], ['wss://empty.summary'])).size,
    0,
  );
});

test('reactions are counted per post and a withdrawn one is not', async () => {
  const kept = react(one, POST, '+');
  const withdrawn = react(two, POST, '+');
  const elsewhere = react(two, OTHER, '🔥');
  const withdrawal = signed(two, {
    kind: 5,
    tags: [['e', withdrawn.id]],
    created_at: 1_700_000_100,
  });
  const relay = fakeRelay('wss://full.summary', {
    events: [kept, withdrawn, elsewhere, withdrawal],
  });
  const summaries = await fetchReactionSummaries(
    [POST, OTHER, QUIET, POST],
    ['wss://full.summary'],
  );
  assert.equal(summaries.get(POST)?.[0]?.count, 1);
  assert.equal(summaries.get(OTHER)?.[0]?.content, '🔥');
  assert.equal(summaries.has(QUIET), false);
  assert.deepEqual(relay.requests[0]?.['#e'], [POST, OTHER, QUIET]);

  assert.equal(
    (await fetchReactionSummary(OTHER, ['wss://full.summary']))[0]?.count,
    1,
  );
  assert.deepEqual(
    await fetchReactionSummary(QUIET, ['wss://full.summary']),
    [],
  );
});

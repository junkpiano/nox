/**
 * The rest of the relay query layer: which copy of a replaceable event is
 * newest, waiting on every relay for one, and several filters asked as one
 * REQ would OR them - without a page cursor stepping over a hole.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey } from 'nostr-tools';
import {
  NoRelayAnsweredError,
  newestOf,
  queryEveryRelay,
  queryRelaysAny,
  type SubscriptionOpener,
  supersedes,
} from '../src/common/relay-query.js';
import type { NostrEvent } from '../types/nostr';
import { fakeRelay, signed } from './fake-relay.js';

const key: Uint8Array = generateSecretKey();

test('a later copy supersedes, and within one second the lower id does', () => {
  assert.equal(
    supersedes({ created_at: 2, id: 'b' }, { created_at: 1, id: 'a' }),
    true,
  );
  assert.equal(
    supersedes({ created_at: 1, id: 'a' }, { created_at: 1, id: 'b' }),
    true,
  );
  assert.equal(
    supersedes({ created_at: 1, id: 'b' }, { created_at: 1, id: 'a' }),
    false,
  );
  assert.equal(newestOf([]), null);
  const a = { created_at: 5, id: 'z' } as NostrEvent;
  const b = { created_at: 5, id: 'y' } as NostrEvent;
  assert.equal(newestOf([a, b]), b);
});

test('asking every relay waits for the slow one instead of a grace period', async () => {
  const late = { id: 'late', created_at: 9 } as NostrEvent;
  const open: SubscriptionOpener = async (relayUrl, _filter, handlers) => {
    const delay: number = relayUrl === 'wss://slow' ? 1700 : 0;
    setTimeout((): void => {
      if (relayUrl === 'wss://slow') handlers.onEvent?.(late);
      handlers.onEose?.();
    }, delay);
    return (): void => {};
  };
  const events = await queryEveryRelay(['wss://fast', 'wss://slow'], {}, open);
  assert.deepEqual(
    events.map((event) => event.id),
    ['late'],
  );
});

test('several filters are merged with each event once', async () => {
  const note = signed(key, { kind: 1, content: 'n', created_at: 10 });
  const repost = signed(key, { kind: 6, content: '', created_at: 20 });
  const relay = fakeRelay('wss://merge.any', { events: [note, repost] });
  const events = await queryRelaysAny(
    ['wss://merge.any'],
    [{ kinds: [1] }, { kinds: [1, 6] }],
    { since: 5 },
  );
  assert.deepEqual(
    events.map((event) => event.id).sort(),
    [note.id, repost.id].sort(),
  );
  assert.deepEqual(relay.requests[0], { kinds: [1], since: 5 });
  // A single filter is accepted as it is.
  assert.equal(
    (await queryRelaysAny(['wss://merge.any'], { kinds: [6] })).length,
    1,
  );
});

test('older posts than a full filter reached are left for the next page', async () => {
  const at = (kind: number, created_at: number): NostrEvent =>
    signed(key, { kind, content: `${kind}@${created_at}`, created_at });
  const full = [at(1, 300), at(1, 250)];
  const sparse = [at(6, 280), at(6, 100)];
  fakeRelay('wss://page.any', { events: [...full, ...sparse] });
  const events = await queryRelaysAny(
    ['wss://page.any'],
    [{ kinds: [1] }, { kinds: [6] }],
    { limit: 2 },
  );
  assert.deepEqual(
    events.map((event) => event.created_at).sort((a, b) => b - a),
    [300, 280, 250],
  );
});

test('one filter answered and another unheard is an error, not a partial page', async () => {
  fakeRelay('wss://half.any', {
    closes: (filter) => (filter.kinds as number[]).includes(6),
  });
  await assert.rejects(
    queryRelaysAny(['wss://half.any'], [{ kinds: [1] }, { kinds: [6] }]),
    NoRelayAnsweredError,
  );
  // Nobody answering anything is simply empty.
  fakeRelay('wss://none.any', { refuses: true });
  assert.deepEqual(
    await queryRelaysAny(['wss://none.any'], [{ kinds: [1] }, { kinds: [6] }]),
    [],
  );
});

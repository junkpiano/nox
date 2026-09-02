import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cacheDeletionStatus,
  createDeletionGate,
  findDeletedIds,
  getCachedDeletionStatus,
} from '../src/common/deletion-gate.js';
import type { NostrEvent } from '../types/nostr';

let counter: number = 0;
function note(id?: string): NostrEvent {
  counter += 1;
  return {
    id: id ?? `id-${counter}`,
    pubkey: 'a'.repeat(64),
    created_at: 1700000000 + counter,
    kind: 1,
    tags: [],
    content: `note ${counter}`,
    sig: '',
  } as NostrEvent;
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// --- asking once and remembering ---------------------------------------------

test('deletion: the relays are asked only about events nobody has asked about', async () => {
  const a = note();
  const b = note();
  const c = note();
  cacheDeletionStatus(a.id, true);
  cacheDeletionStatus(b.id, false);
  const asked: string[][] = [];
  const deleted = await findDeletedIds(
    ['wss://r'],
    [a, b, c],
    async (_relays, events) => {
      asked.push(events.map((e) => e.id));
      return new Set([c.id]);
    },
  );
  assert.deepEqual(asked, [[c.id]]);
  assert.deepEqual(Array.from(deleted).sort(), [a.id, c.id].sort());
  assert.equal(getCachedDeletionStatus(c.id), true);
});

test('deletion: an answer is remembered, so the next list does not ask again', async () => {
  const a = note();
  let calls: number = 0;
  const fetch = async (): Promise<Set<string>> => {
    calls += 1;
    return new Set();
  };
  await findDeletedIds(['wss://r'], [a], fetch);
  await findDeletedIds(['wss://r'], [a], fetch);
  assert.equal(calls, 1);
  assert.equal(getCachedDeletionStatus(a.id), false);
});

test('deletion: a failed ask remembers nothing and hides nothing', async () => {
  const a = note();
  const deleted = await findDeletedIds(['wss://r'], [a], async () => {
    throw new Error('relay down');
  });
  assert.equal(deleted.size, 0);
  assert.equal(getCachedDeletionStatus(a.id), undefined);
});

// --- the gate ---------------------------------------------------------------------

test('gate: arrivals are held, checked together, and drawn in order without the withdrawn', async () => {
  const a = note();
  const b = note();
  const c = note();
  const drawn: string[][] = [];
  const asked: number[] = [];
  const dropped: string[] = [];
  const gate = createDeletionGate<NostrEvent>({
    relays: ['wss://r'],
    delayMs: 20,
    render: (events) => drawn.push(events.map((e) => e.id)),
    onDeleted: (ids) => dropped.push(...ids),
    fetch: async (_relays, events) => {
      asked.push(events.length);
      return new Set([b.id]);
    },
  });
  gate.offer(a);
  gate.offer(b);
  gate.offer(c);
  assert.deepEqual(drawn, [], 'drew before checking');
  await tick(40);
  await gate.settle();
  assert.deepEqual(asked, [3]);
  assert.deepEqual(drawn, [[a.id, c.id]]);
  assert.deepEqual(dropped, [b.id]);
});

test('gate: flush draws what is waiting at once, and settle waits for every check', async () => {
  const a = note();
  const b = note();
  const drawn: string[] = [];
  const gate = createDeletionGate<NostrEvent>({
    relays: ['wss://r'],
    delayMs: 1000,
    render: (events) => drawn.push(...events.map((e) => e.id)),
    fetch: async () => {
      await tick(10);
      return new Set();
    },
  });
  gate.offer(a);
  void gate.flush();
  gate.offer(b);
  await gate.settle();
  assert.deepEqual(drawn, [a.id, b.id]);
});

test('gate: nothing waiting means nothing asked', async () => {
  let calls: number = 0;
  const gate = createDeletionGate<NostrEvent>({
    relays: ['wss://r'],
    delayMs: 10,
    render: () => {},
    fetch: async () => {
      calls += 1;
      return new Set();
    },
  });
  await gate.flush();
  await gate.settle();
  assert.equal(calls, 0);
});

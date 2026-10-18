import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReactors } from '../src/common/reaction-summary.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const alice = 'a'.repeat(64) as PubkeyHex;
const bob = 'b'.repeat(64) as PubkeyHex;
const carol = 'c'.repeat(64) as PubkeyHex;

let serial: number = 0;
const reaction = (pubkey: PubkeyHex, createdAt: number): NostrEvent =>
  ({
    id: (serial++).toString(16).padStart(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: 7,
    tags: [['e', 'f'.repeat(64)]],
    content: '+',
    sig: '',
  }) as NostrEvent;

test('each person is one row, counting how many times they reacted', () => {
  const rows = groupReactors([
    reaction(alice, 10),
    reaction(bob, 20),
    reaction(alice, 30),
    reaction(alice, 5),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.pubkey, row.count]),
    [
      [alice, 3],
      [bob, 1],
    ],
  );
});

test('rows are ordered by each person’s most recent reaction', () => {
  const rows = groupReactors([
    reaction(alice, 100),
    reaction(bob, 300),
    reaction(carol, 200),
    reaction(alice, 50),
  ]);
  assert.deepEqual(
    rows.map((row) => row.pubkey),
    [bob, carol, alice],
  );
});

test('no reactions, no rows', () => {
  assert.deepEqual(groupReactors([]), []);
});

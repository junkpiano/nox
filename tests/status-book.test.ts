import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStatusBook } from '../src/common/status-book.js';
import type { PubkeyHex } from '../types/nostr.js';

const A = 'a'.repeat(64) as PubkeyHex;
const B = 'b'.repeat(64) as PubkeyHex;
const C = 'c'.repeat(64) as PubkeyHex;
const RELAYS = ['wss://relay.example'];

function lookupThatAnswers(answers: Record<string, string>) {
  const asked: PubkeyHex[][] = [];
  const lookup = async ({ pubkeys }: { pubkeys: PubkeyHex[] }) => {
    asked.push(pubkeys);
    const found = new Map();
    for (const pubkey of pubkeys) {
      const text = answers[pubkey];
      if (text) found.set(pubkey, { text, url: null });
    }
    return found;
  };
  return { asked, lookup };
}

test('status book: everyone on screen is asked about once, in one question', async () => {
  const { asked, lookup } = lookupThatAnswers({ [A]: 'at the beach' });
  const book = createStatusBook(lookup);

  const first = await book.ask([A, B, A], RELAYS);
  assert.deepEqual(asked, [[A, B]]);
  assert.equal(first.get(A)?.text, 'at the beach');
  assert.equal(first.has(B), false);

  // The list grew by one person; only they are asked about, and the answer
  // still carries everyone the book knows.
  const second = await book.ask([A, B, C], RELAYS);
  assert.deepEqual(asked, [[A, B], [C]]);
  assert.equal(second.get(A)?.text, 'at the beach');
});

test('status book: a person with no status is not asked about again', async () => {
  const { asked, lookup } = lookupThatAnswers({});
  const book = createStatusBook(lookup);
  await book.ask([A], RELAYS);
  await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A]]);
});

test('status book: two screens asking at once ask once, and both hear the answer', async () => {
  let release: () => void = () => {};
  const asked: PubkeyHex[][] = [];
  const book = createStatusBook(async ({ pubkeys }) => {
    asked.push(pubkeys);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return new Map([[A, { text: 'busy', url: null }]]);
  });

  const one = book.ask([A], RELAYS);
  const two = book.ask([A], RELAYS);
  release();
  const [fromOne, fromTwo] = await Promise.all([one, two]);
  assert.deepEqual(asked, [[A]]);
  assert.equal(fromOne.get(A)?.text, 'busy');
  // The second asker did not ask, but it waited for the answer: a profile
  // header and the list under it ask about the same person at once, and
  // the list drawing itself from nothing would never hear.
  assert.equal(fromTwo.get(A)?.text, 'busy');
});

test('status book: someone already known is answered without a wait', async () => {
  const { asked, lookup } = lookupThatAnswers({ [A]: 'here' });
  const book = createStatusBook(lookup);
  await book.ask([A], RELAYS);
  const again = await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A]]);
  assert.equal(again.get(A)?.text, 'here');
});

test('status book: a lookup that fails is forgotten, so the next screen may ask', async () => {
  let calls = 0;
  const book = createStatusBook(async () => {
    calls += 1;
    if (calls === 1) throw new Error('no relay answered');
    return new Map([[A, { text: 'back', url: null }]]);
  });

  const first = await book.ask([A], RELAYS);
  assert.equal(first.size, 0);
  const second = await book.ask([A], RELAYS);
  assert.equal(calls, 2);
  assert.equal(second.get(A)?.text, 'back');
});

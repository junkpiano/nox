import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createStatusBook,
  STATUS_ANSWER_TTL_SECONDS,
} from '../src/common/status-book.js';
import type { UserStatus } from '../src/features/profile/user-status.js';
import type { PubkeyHex } from '../types/nostr.js';

const A = 'a'.repeat(64) as PubkeyHex;
const B = 'b'.repeat(64) as PubkeyHex;
const C = 'c'.repeat(64) as PubkeyHex;
const RELAYS = ['wss://relay.example'];
const START = 1_800_000_000;
const WEEK = 7 * 86_400;

/** A clock the test moves by hand. */
function clock(at: number = START) {
  let now = at;
  return {
    now: (): number => now,
    advance: (seconds: number): void => {
      now += seconds;
    },
  };
}

function lookupThatAnswers(answers: Record<string, string | UserStatus>) {
  const asked: PubkeyHex[][] = [];
  const lookup = async ({ pubkeys }: { pubkeys: PubkeyHex[] }) => {
    asked.push(pubkeys);
    const found = new Map<PubkeyHex, UserStatus>();
    for (const pubkey of pubkeys) {
      const answer = answers[pubkey];
      if (typeof answer === 'string') {
        found.set(pubkey, { text: answer, url: null, until: START + WEEK });
      } else if (answer) {
        found.set(pubkey, answer);
      }
    }
    return found;
  };
  return { asked, lookup };
}

test('status book: everyone on screen is asked about once, in one question', async () => {
  const { asked, lookup } = lookupThatAnswers({ [A]: 'at the beach' });
  const book = createStatusBook(lookup, clock().now);

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

test('status book: a person with no status is not asked about again straight away', async () => {
  const { asked, lookup } = lookupThatAnswers({});
  const book = createStatusBook(lookup, clock().now);
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
    return new Map([[A, { text: 'busy', url: null, until: START + WEEK }]]);
  }, clock().now);

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

test('status book: a lookup that fails is forgotten, so the next screen may ask', async () => {
  let calls = 0;
  const book = createStatusBook(async () => {
    calls += 1;
    if (calls === 1) throw new Error('no relay answered');
    return new Map([[A, { text: 'back', url: null, until: START + WEEK }]]);
  }, clock().now);

  const first = await book.ask([A], RELAYS);
  assert.equal(first.size, 0);
  const second = await book.ask([A], RELAYS);
  assert.equal(calls, 2);
  assert.equal(second.get(A)?.text, 'back');
});

test('status book: someone already known is answered without a wait', async () => {
  const { asked, lookup } = lookupThatAnswers({ [A]: 'here' });
  const book = createStatusBook(lookup, clock().now);
  await book.ask([A], RELAYS);
  const again = await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A]]);
  assert.equal(again.get(A)?.text, 'here');
});

test('status book: an answer is believed for a while, then the person is asked again', async () => {
  const time = clock();
  const answers: Record<string, string> = { [A]: 'walking the dog' };
  const { asked, lookup } = lookupThatAnswers(answers);
  const book = createStatusBook(lookup, time.now);

  await book.ask([A], RELAYS);
  time.advance(STATUS_ANSWER_TTL_SECONDS - 1);
  await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A]], 'still believed');

  // The author changed it in the meantime.
  answers[A] = 'home again';
  time.advance(1);
  const later = await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A], [A]]);
  assert.equal(later.get(A)?.text, 'home again');
});

test('status book: a status the author cleared is gone on the next ask', async () => {
  const time = clock();
  const answers: Record<string, string> = { [A]: 'busy' };
  const { lookup } = lookupThatAnswers(answers);
  const book = createStatusBook(lookup, time.now);

  await book.ask([A], RELAYS);
  delete answers[A];
  time.advance(STATUS_ANSWER_TTL_SECONDS);
  const later = await book.ask([A], RELAYS);
  assert.equal(later.has(A), false);
  assert.equal(book.known().has(A), false);
});

test('status book: a status is dropped the moment its own expiry passes', async () => {
  const time = clock();
  // Well inside the TTL, so only the author's own expiry can be doing the
  // work here.
  const { asked, lookup } = lookupThatAnswers({
    [A]: { text: 'back in one', url: null, until: START + 60 },
  });
  const book = createStatusBook(lookup, time.now);

  await book.ask([A], RELAYS);
  time.advance(59);
  assert.equal(book.known().get(A)?.text, 'back in one');
  time.advance(1);
  // Nobody asked, and it is gone anyway: the author said when.
  assert.equal(book.known().has(A), false);

  // Asking again now asks the relays, even inside the TTL: what was held
  // has run out on its own, and there may be a newer one.
  await book.ask([A], RELAYS);
  assert.deepEqual(asked, [[A], [A]]);
});

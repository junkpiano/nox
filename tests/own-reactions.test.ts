/**
 * Whether a card's ♡ is already filled.
 *
 * The fixtures are really signed, so a forgery is a real forgery: a kind 7
 * carrying your pubkey and somebody else's signature, which a relay could
 * send to make you think you liked something - or to hide that you did.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  collectOwnReactions,
  createReactionBook,
  fetchOwnReactions,
  type OwnReactions,
  REACTION_ANSWER_TTL_SECONDS,
} from '../src/common/own-reactions.js';
import type { SubscriptionOpener } from '../src/common/relay-query.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const NOW: number = Math.floor(Date.now() / 1000);
const me = generateSecretKey();
const other = generateSecretKey();
const ME = getPublicKey(me) as PubkeyHex;
const POST_A = '1'.repeat(64);
const POST_B = '2'.repeat(64);
const RELAYS = ['wss://relay.example'];

/** As a relay would deliver it: through JSON, without the signer's mark. */
function delivered(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function signed(
  key: Uint8Array,
  kind: number,
  tags: string[][],
  content: string = '',
  createdAt: number = NOW - 60,
): NostrEvent {
  return delivered(
    finalizeEvent(
      { kind, created_at: createdAt, tags, content },
      key,
    ) as NostrEvent,
  );
}

const like = (key: Uint8Array, target: string): NostrEvent =>
  signed(key, 7, [['e', target]], '+');
const repost = (key: Uint8Array, target: string): NostrEvent =>
  signed(key, 6, [['e', target]]);
const withdraw = (key: Uint8Array, reactionId: string): NostrEvent =>
  signed(key, 5, [['e', reactionId]]);

test('own reactions: your signed like and repost fill the card', () => {
  const found = collectOwnReactions(
    ME,
    [POST_A, POST_B],
    [like(me, POST_A), repost(me, POST_B)],
    [],
  );
  assert.deepEqual([...found.liked], [POST_A]);
  assert.deepEqual([...found.reposted], [POST_B]);
});

test("own reactions: a like with your pubkey and somebody else's signature is not yours", () => {
  const forged: NostrEvent = { ...like(other, POST_A), pubkey: ME };
  const found = collectOwnReactions(ME, [POST_A], [forged], []);
  assert.equal(found.liked.size, 0);
});

test("own reactions: somebody else's genuine like is theirs, not yours", () => {
  const found = collectOwnReactions(ME, [POST_A], [like(other, POST_A)], []);
  assert.equal(found.liked.size, 0);
});

test('own reactions: a like you withdrew no longer counts, and only you can withdraw it', () => {
  const mine = like(me, POST_A);
  const byMe = collectOwnReactions(
    ME,
    [POST_A],
    [mine],
    [withdraw(me, mine.id)],
  );
  assert.equal(byMe.liked.size, 0);
  const byOther = collectOwnReactions(
    ME,
    [POST_A],
    [mine],
    [withdraw(other, mine.id)],
  );
  assert.deepEqual([...byOther.liked], [POST_A]);
});

test('own reactions: a like on a post nobody asked about is ignored', () => {
  const found = collectOwnReactions(ME, [POST_A], [like(me, POST_B)], []);
  assert.equal(found.liked.size, 0);
});

/** Relays that behave as scripted, answering every filter with `events`. */
function scripted(
  behaviour: Record<string, 'answer' | 'refuse'>,
  events: NostrEvent[] = [],
): SubscriptionOpener {
  return async (relayUrl, _filter, subscription) => {
    if (behaviour[relayUrl] === 'refuse') throw new Error('refused');
    queueMicrotask((): void => {
      for (const event of events) subscription.onEvent?.(event);
      subscription.onEose?.();
    });
    return (): void => {};
  };
}

test('own reactions: every relay failing is an error, not "liked nothing"', async () => {
  await assert.rejects(
    fetchOwnReactions(
      ME,
      [POST_A],
      ['wss://a'],
      scripted({ 'wss://a': 'refuse' }),
    ),
    NoRelayAnsweredError,
  );
  await assert.rejects(
    fetchOwnReactions(ME, [POST_A], []),
    NoRelayAnsweredError,
  );
});

test('own reactions: what a relay sends is judged the same way', async () => {
  const forged: NostrEvent = { ...like(other, POST_B), pubkey: ME };
  const found = await fetchOwnReactions(
    ME,
    [POST_A, POST_B],
    ['wss://a'],
    scripted({ 'wss://a': 'answer' }, [like(me, POST_A), forged]),
  );
  assert.deepEqual([...found.liked], [POST_A]);
});

function clock(at: number = NOW) {
  let now = at;
  return {
    now: (): number => now,
    advance: (s: number): void => {
      now += s;
    },
  };
}

function lookupThatAnswers(answers: () => OwnReactions) {
  const asked: string[][] = [];
  const lookup = async (_viewer: PubkeyHex, ids: string[]) => {
    asked.push(ids);
    return answers();
  };
  return { asked, lookup };
}

test('reaction book: the posts on screen are asked about once, together', async () => {
  const { asked, lookup } = lookupThatAnswers(() => ({
    liked: new Set([POST_A]),
    reposted: new Set(),
  }));
  const book = createReactionBook(lookup, clock().now);
  const first = await book.ask(ME, [POST_A, POST_B, POST_A], RELAYS);
  assert.deepEqual(asked, [[POST_A, POST_B]]);
  assert.deepEqual([...first.liked], [POST_A]);
  await book.ask(ME, [POST_A, POST_B], RELAYS);
  assert.deepEqual(asked, [[POST_A, POST_B]], 'not asked again');
});

test('reaction book: a like made here shows at once, without asking', async () => {
  const { asked, lookup } = lookupThatAnswers(() => ({
    liked: new Set(),
    reposted: new Set(),
  }));
  const book = createReactionBook(lookup, clock().now);
  await book.ask(ME, [POST_A], RELAYS);
  book.mark(ME, POST_A, 'like');
  assert.ok(book.known(ME).liked.has(POST_A));
  book.unmark(ME, POST_A, 'like');
  assert.ok(!book.known(ME).liked.has(POST_A));
  book.mark(ME, POST_A, 'like');
  assert.deepEqual([...book.known(ME).liked], [POST_A]);
  await book.ask(ME, [POST_A], RELAYS);
  assert.equal(asked.length, 1);
});

test('reaction book: an answer is believed for a while, then asked again', async () => {
  const time = clock();
  let liked = new Set([POST_A]);
  const { asked, lookup } = lookupThatAnswers(() => ({
    liked,
    reposted: new Set(),
  }));
  const book = createReactionBook(lookup, time.now);
  await book.ask(ME, [POST_A], RELAYS);
  // Withdrawn on another client in the meantime.
  liked = new Set();
  time.advance(REACTION_ANSWER_TTL_SECONDS);
  const later = await book.ask(ME, [POST_A], RELAYS);
  assert.equal(asked.length, 2);
  assert.equal(later.liked.has(POST_A), false);
});

test('reaction book: a failed ask is forgotten, so the next screen asks again', async () => {
  let calls = 0;
  const book = createReactionBook(async () => {
    calls += 1;
    if (calls === 1) throw new Error('nobody answered');
    return { liked: new Set([POST_A]), reposted: new Set() };
  }, clock().now);
  const first = await book.ask(ME, [POST_A], RELAYS);
  assert.equal(first.liked.size, 0);
  const second = await book.ask(ME, [POST_A], RELAYS);
  assert.equal(calls, 2);
  assert.deepEqual([...second.liked], [POST_A]);
});

test('reaction book: a different viewer starts from nothing', async () => {
  const { lookup } = lookupThatAnswers(() => ({
    liked: new Set([POST_A]),
    reposted: new Set(),
  }));
  const book = createReactionBook(lookup, clock().now);
  await book.ask(ME, [POST_A], RELAYS);
  const someoneElse = getPublicKey(other) as PubkeyHex;
  assert.equal(book.known(someoneElse).liked.size, 0);
});

test('reaction book: two screens asking at once ask once and both hear', async () => {
  let release: () => void = () => {};
  let calls = 0;
  const book = createReactionBook(async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { liked: new Set([POST_A]), reposted: new Set() };
  }, clock().now);
  const one = book.ask(ME, [POST_A], RELAYS);
  const two = book.ask(ME, [POST_A], RELAYS);
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.ok(a.liked.has(POST_A) && b.liked.has(POST_A));
});

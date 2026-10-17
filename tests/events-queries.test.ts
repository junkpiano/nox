/**
 * Follow lists, single events, deletions and replies, asked of relays that
 * live in memory: the real socket code runs underneath.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  fetchEventById,
  fetchFollowList,
  fetchLatestFollowListEvent,
  fetchRepliesForEvent,
  isEventDeleted,
  lookupFollowList,
  rememberedFollows,
  rememberFollowList,
  replyFilters,
} from '../src/common/events-queries.js';
import { kvSet } from '../src/common/kv.js';
import { VIEWER_KEY } from '../src/common/session.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import { fakeRelays, installFakeWebSocket, storeRelay } from './fake-relay-store.js';

installFakeWebSocket();

const key: Uint8Array = generateSecretKey();
const me: PubkeyHex = getPublicKey(key) as PubkeyHex;
const other: Uint8Array = generateSecretKey();
const friend = (n: number): PubkeyHex =>
  n.toString(16).padStart(64, '0') as PubkeyHex;
const now = (): number => Math.floor(Date.now() / 1000);

function sign(
  kind: number,
  created_at: number,
  tags: string[][] = [],
  content: string = '',
  secret: Uint8Array = key,
): NostrEvent {
  return finalizeEvent(
    { kind, created_at, tags, content },
    secret,
  ) as unknown as NostrEvent;
}

const follows = (created_at: number, ...people: PubkeyHex[]): NostrEvent =>
  sign(
    3,
    created_at,
    people.map((p: PubkeyHex): string[] => ['p', p]),
  );

let relayCount: number = 0;
/** A fresh relay URL holding `events`, so no test shares a socket. */
function relay(events: NostrEvent[] | 'refuse'): string {
  relayCount += 1;
  const url = `wss://r${relayCount}.example`;
  fakeRelays.set(
    url,
    events === 'refuse' ? { refuse: true } : storeRelay(events),
  );
  return url;
}

test('reply filters ask for kind 1 and comments by e, and for comments on comments by E', () => {
  assert.deepEqual(replyFilters('abc'), [
    { kinds: [1, 1111], '#e': ['abc'], limit: 200 },
    { kinds: [1111], '#E': ['abc'], limit: 200 },
  ]);
});

test('the newest follow list across relays wins, and an answer is an answer', async () => {
  const older: NostrEvent = follows(1_700_000_000, friend(1));
  const newer: NostrEvent = follows(1_700_000_100, friend(1), friend(2));
  const result = await lookupFollowList(
    me,
    [relay([older]), relay([newer]), relay('refuse')],
    { waitForAll: true },
  );
  assert.equal(result.event?.id, newer.id);
  assert.equal(result.answered, true);
});

test('in the same second, the list with more entries wins', async () => {
  const t = 1_700_000_000;
  const small: NostrEvent = follows(t, friend(1));
  const big: NostrEvent = follows(t, friend(1), friend(2), friend(3));
  const event = await fetchLatestFollowListEvent(me, [relay([big, small])]);
  assert.equal(event?.id, big.id);
});

test('a follow list dated far in the future is ignored', async () => {
  const future: NostrEvent = follows(now() + 3600, friend(9));
  const honest: NostrEvent = follows(1_700_000_000, friend(1));
  const event = await fetchLatestFollowListEvent(me, [relay([future, honest])]);
  assert.equal(event?.id, honest.id);
});

test('a relay with no list is an answer; no relay at all is not', async () => {
  const empty = await lookupFollowList(me, [relay([])]);
  assert.deepEqual(empty, { event: null, answered: true });
  const unreachable = await lookupFollowList(me, [relay('refuse')]);
  assert.deepEqual(unreachable, { event: null, answered: false });
});

test('fetchFollowList returns each followed pubkey once and remembers them for the viewer', async () => {
  kvSet(VIEWER_KEY, me);
  const list: NostrEvent = follows(
    1_700_000_000,
    friend(1),
    friend(2),
    friend(1),
  );
  const got = await fetchFollowList(me, [relay([list])]);
  assert.deepEqual(got, [friend(1), friend(2)]);
  assert.deepEqual(rememberedFollows(me), [friend(1), friend(2)]);
  assert.deepEqual(await fetchFollowList(me, [relay([])]), []);
});

test('a remembered follow list is replaced only by a newer one', () => {
  const viewer: Uint8Array = generateSecretKey();
  const pubkey: PubkeyHex = getPublicKey(viewer) as PubkeyHex;
  kvSet(VIEWER_KEY, pubkey);
  const list = (t: number, ...people: PubkeyHex[]): NostrEvent =>
    sign(
      3,
      t,
      people.map((p: PubkeyHex): string[] => ['p', p]),
      '',
      viewer,
    );
  assert.equal(rememberedFollows(pubkey), null);
  rememberFollowList(pubkey, list(200, friend(2)));
  rememberFollowList(pubkey, list(100, friend(1)));
  assert.deepEqual(rememberedFollows(pubkey), [friend(2)]);
  rememberFollowList(pubkey, list(300, friend(3), friend(3)));
  assert.deepEqual(rememberedFollows(pubkey), [friend(3)]);
  rememberFollowList(pubkey, list(now() + 3600, friend(4)));
  assert.deepEqual(rememberedFollows(pubkey), [friend(3)]);
});

test("only the viewer's own kind 3 is remembered", () => {
  kvSet(VIEWER_KEY, me);
  const someone: PubkeyHex = getPublicKey(other) as PubkeyHex;
  rememberFollowList(
    someone,
    sign(3, 1_700_000_000, [['p', friend(5)]], '', other),
  );
  assert.equal(rememberedFollows(someone), null);
  const before = rememberedFollows(me);
  rememberFollowList(me, sign(1, 1_800_000_000, [['p', friend(5)]]));
  assert.deepEqual(rememberedFollows(me), before);
});

test('a remembered list that is not one reads as none, and invalid entries are dropped', () => {
  const pubkey = friend(77);
  kvSet(`nostr_follows:${pubkey}`, 'not json');
  assert.equal(rememberedFollows(pubkey), null);
  kvSet(
    `nostr_follows:${pubkey}`,
    JSON.stringify({ follows: [friend(1), 'nope', 3] }),
  );
  assert.deepEqual(rememberedFollows(pubkey), [friend(1)]);
});

test('an event is fetched from whichever relay has it', async () => {
  const target: NostrEvent = sign(1, 1_700_000_000, [], 'hello');
  const event = await fetchEventById(target.id, [
    relay('refuse'),
    relay([]),
    relay([target]),
  ]);
  assert.equal(event?.id, target.id);
});

test('an event nobody has, or asked of nobody, is null', async () => {
  const missing: string = 'f'.repeat(64);
  assert.equal(await fetchEventById(missing, []), null);
  assert.equal(
    await fetchEventById(missing, [relay([]), relay('refuse')]),
    null,
  );
});

test('an event is deleted when its author published a kind 5 naming it', async () => {
  const target: NostrEvent = sign(1, 1_700_000_000, [], 'oops');
  const deletion: NostrEvent = sign(5, 1_700_000_100, [['e', target.id]]);
  assert.equal(
    await isEventDeleted(target.id, me, [relay([]), relay([deletion])]),
    true,
  );
});

test('no deletion, no relays, or unreachable relays all read as not deleted', async () => {
  const target: NostrEvent = sign(1, 1_700_000_000, [], 'fine');
  const unrelated: NostrEvent = sign(5, 1_700_000_100, [['e', 'a'.repeat(64)]]);
  assert.equal(await isEventDeleted(target.id, me, []), false);
  assert.equal(
    await isEventDeleted(target.id, me, [relay([unrelated])]),
    false,
  );
  assert.equal(await isEventDeleted(target.id, me, [relay('refuse')]), false);
});

test('a deletion by someone else does not delete the event', async () => {
  const target: NostrEvent = sign(1, 1_700_000_000, [], 'mine');
  const impostor: NostrEvent = sign(
    5,
    1_700_000_100,
    [['e', target.id]],
    '',
    other,
  );
  assert.equal(await isEventDeleted(target.id, me, [relay([impostor])]), false);
});

test('replies come back oldest first: direct ones, comments on comments, and deeper replies in the thread', async () => {
  const root: NostrEvent = sign(1, 1_700_000_000, [], 'root');
  const middle: NostrEvent = sign(
    1,
    1_700_000_010,
    [['e', root.id, '', 'root']],
    'middle',
  );
  const direct: NostrEvent = sign(
    1,
    1_700_000_030,
    [
      ['e', root.id, '', 'root'],
      ['e', middle.id, '', 'reply'],
    ],
    'direct reply',
  );
  const comment: NostrEvent = sign(
    1111,
    1_700_000_020,
    [
      ['E', middle.id],
      ['e', middle.id],
    ],
    'comment',
  );
  const commentOnComment: NostrEvent = sign(
    1111,
    1_700_000_040,
    [
      ['E', middle.id],
      ['e', comment.id],
    ],
    'comment on comment',
  );
  const deeper: NostrEvent = sign(
    1,
    1_700_000_050,
    [
      ['e', root.id, '', 'root'],
      ['e', direct.id, '', 'reply'],
    ],
    'deeper',
  );
  const elsewhere: NostrEvent = sign(
    1,
    1_700_000_005,
    [['e', root.id, '', 'root']],
    'sibling elsewhere in the thread',
  );
  const replies = await fetchRepliesForEvent(middle, [
    relay([direct, comment, commentOnComment, deeper, elsewhere]),
    relay('refuse'),
  ]);
  assert.deepEqual(
    replies.map((event: NostrEvent): string => event.content),
    ['comment', 'direct reply', 'comment on comment', 'deeper'],
  );
  assert.deepEqual(await fetchRepliesForEvent(middle, []), []);
});

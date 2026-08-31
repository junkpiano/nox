/**
 * Finding a person by name, when the relay cannot rank.
 *
 * NIP-50 returns kind 0 profiles ordered by how recently each was edited, so
 * the raw list is bots, bridges and same-named strangers, and the person meant
 * is wherever their last profile edit happens to fall. The ranking exists to
 * undo that ordering using only what the client already holds, so these tests
 * pin the tiers and the tie-break rather than any particular relay's output.
 *
 * A pasted key is the other half: it names one person exactly, and must not be
 * handed to a search relay as text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePubkeyQuery,
  rankUserResults,
  renderUserResults,
  type UserSearchResult,
} from '../src/features/search/user-search.js';
import type { NostrProfile, Npub, PubkeyHex } from '../types/nostr';

/**
 * The profile cache reads and writes localStorage, which node has not got.
 * Rendering is the subject here, not caching, so a map standing in for it is
 * enough - and its absence would otherwise make the cache silently disable
 * itself, which is the branch we are least interested in.
 */
const storage: Map<string, string> = new Map();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string): string | null => storage.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    storage.set(k, String(v));
  },
  removeItem: (k: string): void => {
    storage.delete(k);
  },
};

/** Stands in for the container element; only these two members are touched. */
interface FakeContainer {
  innerHTML: string;
  style: { display?: string };
}

function container(): FakeContainer {
  return { innerHTML: '', style: {} };
}

function key(seed: string): PubkeyHex {
  return seed.repeat(64).slice(0, 64) as PubkeyHex;
}

function result(
  seed: string,
  profile: NostrProfile,
  createdAt: number = 1_700_000_000,
): UserSearchResult {
  return {
    pubkey: key(seed),
    npub: `npub1${seed}` as Npub,
    profile,
    createdAt,
  };
}

const NOBODY: ReadonlySet<PubkeyHex> = new Set<PubkeyHex>();

test('someone you follow outranks a stranger with the same name', () => {
  const followed: UserSearchResult = result('a', { name: 'jack' }, 1);
  const stranger: UserSearchResult = result('b', { name: 'jack' }, 999);

  const ranked: UserSearchResult[] = rankUserResults(
    [stranger, followed],
    'jack',
    new Set<PubkeyHex>([key('a')]),
  );

  assert.equal(ranked[0]?.pubkey, key('a'));
});

test('an exact name beats a partial match, whatever the relay order', () => {
  // "Cabanela :no-jacket:" is a real shape of result: it matches "jack"
  // only because the substring is buried inside another word.
  const partial: UserSearchResult = result('c', { name: 'no-jacket' }, 999);
  const exact: UserSearchResult = result('d', { name: 'Jack' }, 1);

  const ranked: UserSearchResult[] = rankUserResults(
    [partial, exact],
    'jack',
    NOBODY,
  );

  assert.equal(ranked[0]?.pubkey, key('d'));
});

test('a claimed NIP-05 outranks a profile with none', () => {
  const bare: UserSearchResult = result('e', { name: 'jackson' }, 999);
  const claimed: UserSearchResult = result(
    'f',
    { name: 'jackson', nip05: 'jackson@example.com' },
    1,
  );

  const ranked: UserSearchResult[] = rankUserResults(
    [bare, claimed],
    'jack',
    NOBODY,
  );

  assert.equal(ranked[0]?.pubkey, key('f'));
});

test('within one tier a claimed NIP-05 comes before edit recency', () => {
  // The exact-name tier is a wall of identical strangers - a search for
  // "jack" fills it - and inside that wall "edited most recently" is the
  // signal this whole ranking exists to discard.
  const recent: UserSearchResult = result('1', { name: 'jack' }, 999);
  const claimed: UserSearchResult = result(
    '2',
    { name: 'jack', nip05: 'jack@example.com' },
    1,
  );

  const ranked: UserSearchResult[] = rankUserResults(
    [recent, claimed],
    'jack',
    NOBODY,
  );

  assert.equal(ranked[0]?.pubkey, key('2'));
});

test('a NIP-05 does not promote anyone out of their tier', () => {
  // A stranger with a verified-looking name must still lose to someone the
  // viewer actually follows, and to an exact match.
  const strangerWithNip05: UserSearchResult = result(
    '1',
    { name: 'jackpot', nip05: 'jackpot@example.com' },
    999,
  );
  const followedBare: UserSearchResult = result('2', { name: 'jackal' }, 1);
  const exactBare: UserSearchResult = result('3', { name: 'jack' }, 1);

  const ranked: UserSearchResult[] = rankUserResults(
    [strangerWithNip05, followedBare, exactBare],
    'jack',
    new Set<PubkeyHex>([key('2')]),
  );

  assert.deepEqual(
    ranked.map((entry: UserSearchResult): PubkeyHex => entry.pubkey),
    [key('2'), key('3'), key('1')],
  );
});

test('edit recency still breaks a tie when NIP-05 cannot', () => {
  const older: UserSearchResult = result('1', { name: 'jackal' }, 100);
  const newer: UserSearchResult = result('2', { name: 'jackal' }, 200);

  const ranked: UserSearchResult[] = rankUserResults(
    [older, newer],
    'jack',
    NOBODY,
  );

  assert.deepEqual(
    ranked.map((entry: UserSearchResult): PubkeyHex => entry.pubkey),
    [key('2'), key('1')],
  );
});

test('the full tier order holds when every tier is present at once', () => {
  const other: UserSearchResult = result('1', { name: 'jackpot' }, 900);
  const hasNip05: UserSearchResult = result(
    '2',
    { name: 'jackpot', nip05: 'x@example.com' },
    800,
  );
  const exact: UserSearchResult = result('3', { name: 'jack' }, 700);
  const followed: UserSearchResult = result('4', { name: 'jackfruit' }, 600);

  const ranked: UserSearchResult[] = rankUserResults(
    [other, hasNip05, exact, followed],
    'jack',
    new Set<PubkeyHex>([key('4')]),
  );

  assert.deepEqual(
    ranked.map((entry: UserSearchResult): PubkeyHex => entry.pubkey),
    [key('4'), key('3'), key('2'), key('1')],
  );
});

test('an exact match is found on display_name and nip05 too, and ignores case', () => {
  const byDisplay: UserSearchResult = result('a', { display_name: 'JACK' }, 1);
  const stranger: UserSearchResult = result('b', { name: 'jackhammer' }, 999);

  assert.equal(
    rankUserResults([stranger, byDisplay], 'jack', NOBODY)[0]?.pubkey,
    key('a'),
  );

  const byNip05: UserSearchResult = result(
    'c',
    { nip05: 'jack@example.com' },
    1,
  );
  assert.equal(
    rankUserResults([stranger, byNip05], 'jack@example.com', NOBODY)[0]?.pubkey,
    key('c'),
  );
});

test('a name padded with whitespace still counts as an exact match', () => {
  // The name is a string its owner chose, so it arrives however they typed it.
  const padded: UserSearchResult = result('a', { name: '  Jack\n' }, 1);
  const stranger: UserSearchResult = result('b', { name: 'jackdaw' }, 999);

  assert.equal(
    rankUserResults([stranger, padded], 'jack', NOBODY)[0]?.pubkey,
    key('a'),
  );
});

test('a name containing a hyphen keeps it', () => {
  // Guards a regression in the one-line collapse: a character class meant to
  // strip control characters can silently take the hyphen with it.
  const hyphenated: UserSearchResult = result('a', { name: 'jean-luc' }, 1);
  const stranger: UserSearchResult = result('b', { name: 'jeanluc x' }, 999);

  assert.equal(
    rankUserResults([stranger, hyphenated], 'jean-luc', NOBODY)[0]?.pubkey,
    key('a'),
  );
});

test('ranking leaves the input array alone', () => {
  const first: UserSearchResult = result('1', { name: 'zzz' }, 1);
  const second: UserSearchResult = result('2', { name: 'jack' }, 2);
  const input: UserSearchResult[] = [first, second];

  rankUserResults(input, 'jack', NOBODY);

  assert.deepEqual(input, [first, second]);
});

test('an npub is read as the person it names, not as search text', () => {
  // Kept as a literal: this is the encoding the app must accept from a paste.
  const npub: string =
    'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
  const pubkey: PubkeyHex | null = decodePubkeyQuery(npub);

  assert.equal(
    pubkey,
    '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  );
});

test('a bare hex key is read as a person, in either case', () => {
  const hex: string = 'A'.repeat(64);
  assert.equal(decodePubkeyQuery(hex), 'a'.repeat(64));
  assert.equal(decodePubkeyQuery(`  ${'b'.repeat(64)}  `), 'b'.repeat(64));
});

test('a name is not mistaken for a key', () => {
  assert.equal(decodePubkeyQuery('jack'), null);
  assert.equal(decodePubkeyQuery(''), null);
  assert.equal(decodePubkeyQuery('   '), null);
  // Right prefix, but not a decodable key.
  assert.equal(decodePubkeyQuery('npub1notarealkey'), null);
  // A hex string of the wrong length is a word, not a key.
  assert.equal(decodePubkeyQuery('a'.repeat(63)), null);
  assert.equal(decodePubkeyQuery('a'.repeat(65)), null);
});

test('a name written to break out of its row is escaped, not obeyed', () => {
  const hostile: UserSearchResult = result('a', {
    name: '<img src=x onerror=alert(1)>',
    nip05: '"><script>alert(2)</script>',
  });
  const target: FakeContainer = container();

  renderUserResults(target as unknown as HTMLElement, [hostile]);

  assert.ok(!target.innerHTML.includes('<script>'));
  assert.ok(!target.innerHTML.includes('<img src=x'));
  assert.ok(target.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('a bio is flattened onto its one line', () => {
  const chatty: UserSearchResult = result('b', {
    name: 'x',
    about: 'line one\nline two\tand   more',
  });
  const target: FakeContainer = container();

  renderUserResults(target as unknown as HTMLElement, [chatty]);

  assert.ok(target.innerHTML.includes('line one line two and more'));
});

test('a picture URL that is not fetchable as an image is not put in a src', () => {
  // The picture field is whatever its owner typed. `javascript:` in a src is
  // inert in a browser, but it has no business reaching the attribute.
  const hostile: UserSearchResult = result('c', {
    name: 'x',
    picture: 'javascript:alert(1)',
  });
  const target: FakeContainer = container();

  renderUserResults(target as unknown as HTMLElement, [hostile]);

  assert.ok(!target.innerHTML.includes('javascript:'));
  assert.ok(target.innerHTML.includes('robohash.org'));
});

test('an https picture URL is kept', () => {
  const normal: UserSearchResult = result('d', {
    name: 'x',
    picture: 'https://example.com/me.png',
  });
  const target: FakeContainer = container();

  renderUserResults(target as unknown as HTMLElement, [normal]);

  assert.ok(target.innerHTML.includes('https://example.com/me.png'));
});

test('no people means no People block, rather than an empty one', () => {
  const target: FakeContainer = { innerHTML: 'stale', style: {} };

  renderUserResults(target as unknown as HTMLElement, []);

  assert.equal(target.innerHTML, '');
  assert.equal(target.style.display, 'none');
});

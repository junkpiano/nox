/**
 * Followed hashtags kept in step with the account: the device copy follows
 * the newest list, and an edit is published only from a list every relay
 * agreed on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { onAppEvent } from '../src/common/app-events.js';
import {
  getFollowedHashtags,
  homeFilters,
  MAX_FOLLOWED_HASHTAGS,
  normalizeHashtag,
  refreshFollowedHashtags,
  setHashtagFollowed,
} from '../src/common/interests.js';
import { NoRelayAnsweredError } from '../src/common/relay-query.js';
import { setSessionPrivateKeyFromRaw } from '../src/common/session.js';
import type { PubkeyHex } from '../types/nostr';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

const kv: Map<string, string> = memoryKv();
const key: Uint8Array = generateSecretKey();
const VIEWER: PubkeyHex = getPublicKey(key) as PubkeyHex;
setSessionPrivateKeyFromRaw(nip19.nsecEncode(key));

let updates: number = 0;
onAppEvent('interests-updated', (): void => {
  updates += 1;
});

function list(tags: string[][], created_at: number) {
  return signed(key, { kind: 10015, tags, created_at, content: 'kept' });
}

test('a hashtag is normalised to lowercase without its #', () => {
  assert.equal(normalizeHashtag('  #Nostr '), 'nostr');
});

test('nobody signed in, or a damaged copy, follows no hashtags', () => {
  assert.deepEqual(getFollowedHashtags(null), []);
  kv.set(`nostr_interests:${VIEWER}`, '{oops');
  assert.deepEqual(getFollowedHashtags(VIEWER), []);
  kv.set(`nostr_interests:${VIEWER}`, '"not a list"');
  assert.deepEqual(getFollowedHashtags(VIEWER), []);
  kv.set(`nostr_interests:${VIEWER}`, JSON.stringify(['ok', 3]));
  assert.deepEqual(getFollowedHashtags(VIEWER), ['ok']);
  kv.delete(`nostr_interests:${VIEWER}`);
});

test('the account’s list replaces the device copy, and an older one does not', async () => {
  fakeRelay('wss://new.interests', {
    events: [
      list(
        [
          ['t', 'Rust'],
          ['t', 'nostr'],
        ],
        200,
      ),
    ],
  });
  const before: number = updates;
  assert.deepEqual(
    await refreshFollowedHashtags(VIEWER, ['wss://new.interests']),
    ['rust', 'nostr'],
  );
  assert.equal(updates, before + 1, 'a changed list is announced');

  fakeRelay('wss://old.interests', { events: [list([['t', 'old']], 100)] });
  assert.deepEqual(
    await refreshFollowedHashtags(VIEWER, ['wss://old.interests']),
    ['rust', 'nostr'],
  );
  fakeRelay('wss://none.interests');
  assert.deepEqual(
    await refreshFollowedHashtags(VIEWER, ['wss://none.interests']),
    ['rust', 'nostr'],
  );
  assert.equal(updates, before + 1, 'an unchanged list is not');
});

test('following publishes the whole list from the newer of the device and relay copies', async () => {
  // The relay only has an older list than the one saved above.
  const relay = fakeRelay('wss://edit.interests', {
    events: [list([['t', 'stale']], 50)],
  });
  await setHashtagFollowed(VIEWER, ['wss://edit.interests'], '#Zap', true);
  const sent = relay.published[relay.published.length - 1];
  assert.ok(sent);
  assert.equal(sent.kind, 10015);
  assert.equal(sent.content, 'kept');
  assert.deepEqual(sent.tags, [
    ['t', 'Rust'],
    ['t', 'nostr'],
    ['t', 'zap'],
  ]);
  assert.deepEqual(getFollowedHashtags(VIEWER), ['rust', 'nostr', 'zap']);

  await Promise.all([
    setHashtagFollowed(VIEWER, ['wss://edit.interests'], 'rust', false),
    setHashtagFollowed(VIEWER, ['wss://edit.interests'], 'nostr', false),
  ]);
  assert.deepEqual(getFollowedHashtags(VIEWER), ['zap']);
});

test('an edit is refused when a relay did not answer, the account changed, or nobody accepted', async () => {
  fakeRelay('wss://ok.interests');
  fakeRelay('wss://down.interests', { refuses: true });
  await assert.rejects(
    setHashtagFollowed(
      VIEWER,
      ['wss://ok.interests', 'wss://down.interests'],
      'x',
      true,
    ),
    NoRelayAnsweredError,
  );

  kv.set('nostr_pubkey', 'f'.repeat(64));
  await assert.rejects(
    setHashtagFollowed(VIEWER, ['wss://ok.interests'], 'x', true),
    /account changed/,
  );
  kv.set('nostr_pubkey', VIEWER);

  fakeRelay('wss://reject.interests', { accepts: false });
  await assert.rejects(
    setHashtagFollowed(VIEWER, ['wss://reject.interests'], 'x', true),
    /No relay accepted/,
  );
  assert.deepEqual(getFollowedHashtags(VIEWER), ['zap']);
});

test('Home asks about at most the first hundred hashtags', () => {
  const many: string[] = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const filters = homeFilters([1], ['p'], many);
  assert.equal((filters[1]?.['#t'] as string[]).length, MAX_FOLLOWED_HASHTAGS);
});

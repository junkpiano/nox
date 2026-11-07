/**
 * Asking relays to forget a post: only for the viewer's own posts, signed
 * through the one signer, and sent to every relay given.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, nip19, verifyEvent } from 'nostr-tools';
import {
  requestDeletion,
  withdrawReposts,
} from '../src/common/delete-event.js';
import {
  endSession,
  ReadOnlySessionError,
  setSessionPrivateKeyFromRaw,
  startReadOnlySession,
} from '../src/common/session.js';
import { fakeRelay, memoryKv, signed } from './fake-relay.js';

memoryKv();
// requestDeletion looks up `window.nostr` (unused) before signing, so it
// needs a `window` - as a browser and React Native both have - to run at all.
(globalThis as { window?: unknown }).window = {};

const mine: Uint8Array = generateSecretKey();
const theirs: Uint8Array = generateSecretKey();

test('a deletion for somebody else’s post is refused before signing', async () => {
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(mine));
  const relay = fakeRelay('wss://refuse.delete');
  const post = signed(theirs, { kind: 1, content: 'not mine' });
  await assert.rejects(
    requestDeletion(post, ['wss://refuse.delete']),
    /only delete your own posts/,
  );
  assert.equal(relay.published.length, 0);
});

test('with nobody signed in nothing can be deleted', async () => {
  endSession();
  const post = signed(mine, { kind: 1, content: 'mine' });
  await assert.rejects(
    requestDeletion(post, ['wss://refuse.delete']),
    /only delete your own posts/,
  );
});

test('a read-only session does not sign a deletion', async () => {
  const post = signed(mine, { kind: 1, content: 'mine' });
  startReadOnlySession(post.pubkey);
  await assert.rejects(
    requestDeletion(post, ['wss://refuse.delete']),
    ReadOnlySessionError,
  );
});

test('the viewer’s own post gets a signed kind 5 naming it, sent to each relay', async () => {
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(mine));
  const post = signed(mine, { kind: 1, content: 'regret' });
  const a = fakeRelay('wss://a.delete');
  const b = fakeRelay('wss://b.delete', { accepts: false });
  await requestDeletion(post, ['wss://a.delete', 'wss://b.delete']);
  const sent = a.published[0];
  assert.ok(sent);
  assert.equal(sent.kind, 5);
  assert.equal(sent.pubkey, post.pubkey);
  assert.deepEqual(sent.tags[0], ['e', post.id]);
  assert.ok(verifyEvent(sent));
  // A relay that rejects it is not an error for the caller.
  assert.equal(b.published[0]?.id, sent.id);
});

test('undoing a repost names every repost of yours of that post, and only those', async () => {
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(mine));
  const post = signed(theirs, { kind: 1, content: 'worth sharing' });
  const other = signed(theirs, { kind: 1, content: 'something else' });
  const first = signed(mine, { kind: 6, tags: [['e', post.id]] });
  const again = signed(mine, { kind: 16, tags: [['e', post.id]] });
  const elsewhere = signed(mine, { kind: 6, tags: [['e', other.id]] });
  const someoneElse = signed(theirs, { kind: 6, tags: [['e', post.id]] });
  const relay = fakeRelay('wss://undo.repost', {
    events: [first, again, elsewhere, someoneElse],
  });
  const outcome = await withdrawReposts(first.pubkey, post.id, [
    'wss://undo.repost',
  ]);
  assert.deepEqual(outcome, { found: 2, accepted: 1 });
  const sent = relay.published[0];
  assert.ok(sent && verifyEvent(sent));
  assert.equal(sent.kind, 5);
  const named: string[] = sent.tags
    .filter((tag: string[]): boolean => tag[0] === 'e')
    .map((tag: string[]): string => tag[1] ?? '')
    .sort();
  assert.deepEqual(named, [first.id, again.id].sort());
});

test('with no repost of yours there is nothing to sign', async () => {
  setSessionPrivateKeyFromRaw(nip19.nsecEncode(mine));
  const post = signed(theirs, { kind: 1, content: 'never reposted' });
  const relay = fakeRelay('wss://none.repost');
  const me = signed(mine, { kind: 1, content: '' }).pubkey;
  assert.deepEqual(await withdrawReposts(me, post.id, ['wss://none.repost']), {
    found: 0,
    accepted: 0,
  });
  assert.equal(relay.published.length, 0);
});

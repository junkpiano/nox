/**
 * Asking relays to forget a post: only for the viewer's own posts, signed
 * through the one signer, and sent to every relay given.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, nip19, verifyEvent } from 'nostr-tools';
import { requestDeletion } from '../src/common/delete-event.js';
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

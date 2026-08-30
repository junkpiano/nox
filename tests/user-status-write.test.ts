/**
 * Building the event that publishes a status.
 *
 * The parts worth pinning down are the ones a reader depends on: the `d` tag
 * that says which status this is, the `expiration` that lets other clients
 * drop it without guessing, and the empty content that is how a status is
 * cleared rather than deleted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserStatusEvent } from '../src/features/profile/user-status.js';
import type { PubkeyHex } from '../types/nostr';

const NOW: number = 1_800_000_000;
const PUBKEY: PubkeyHex = 'a'.repeat(64) as PubkeyHex;

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag: string[]): boolean => tag[0] === name)?.[1];
}

test('a status is a general status, addressed to nobody', () => {
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: 'walking the dog',
    expiresInSeconds: null,
    now: NOW,
  });

  assert.equal(event.kind, 30315);
  assert.equal(event.content, 'walking the dog');
  assert.equal(tagValue(event.tags, 'd'), 'general');
  assert.equal(event.created_at, NOW);
});

test('an expiry is written as an absolute time, not a duration', () => {
  // Readers compare it against their own clock; a duration would need them to
  // know when it started.
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: 'in a meeting',
    expiresInSeconds: 3600,
    now: NOW,
  });
  assert.equal(tagValue(event.tags, 'expiration'), String(NOW + 3600));
});

test('no expiry means no tag at all', () => {
  // Rather than a far-future timestamp, which would be a lie about intent.
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: 'here',
    expiresInSeconds: null,
    now: NOW,
  });
  assert.equal(tagValue(event.tags, 'expiration'), undefined);
});

test('clearing a status publishes an empty one', () => {
  // NIP-38 has no delete. Replacing the event with empty content is how a
  // status ends, and every reader already treats empty as nothing to show.
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: '',
    expiresInSeconds: null,
    now: NOW,
  });
  assert.equal(event.content, '');
  assert.equal(tagValue(event.tags, 'd'), 'general');
});

test('what is typed is trimmed and kept to one line', () => {
  // The same shape the reader enforces on everyone else's status. Publishing
  // something this client would refuse to display would be strange.
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: ['  walking', 'the dog  '].join('\n'),
    expiresInSeconds: null,
    now: NOW,
  });
  assert.equal(event.content, 'walking the dog');
});

test('an over-long status is cut to what a reader will show', () => {
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: 'x'.repeat(500),
    expiresInSeconds: null,
    now: NOW,
  });
  assert.ok(event.content.length <= 140, `got ${event.content.length}`);
});

test('the event carries no signature yet', () => {
  // Signing belongs to whoever holds the key - an extension or the session -
  // and this builds the thing they are asked to sign.
  const event = buildUserStatusEvent({
    pubkeyHex: PUBKEY,
    text: 'here',
    expiresInSeconds: null,
    now: NOW,
  });
  assert.equal('id' in event, false);
  assert.equal('sig' in event, false);
  assert.equal(event.pubkey, PUBKEY);
});

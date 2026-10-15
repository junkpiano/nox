import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyNotification,
  notificationTarget,
} from '../src/common/notifications-query.js';
import type { NostrEvent, PubkeyHex } from '../types/nostr';

const viewer = 'a'.repeat(64) as PubkeyHex;
const event = (kind: number, tags: string[][]): NostrEvent =>
  ({
    id: 'f'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind,
    tags,
    content: '',
    sig: '',
  }) as NostrEvent;

test('reactions and reposts are classified by kind', () => {
  assert.equal(
    classifyNotification(event(7, [['p', viewer]]), viewer),
    'reaction',
  );
  assert.equal(
    classifyNotification(event(6, [['p', viewer]]), viewer),
    'repost',
  );
});

test('a note naming you is a reply when it answers something, else a mention', () => {
  assert.equal(
    classifyNotification(
      event(1, [
        ['e', 'x'],
        ['p', viewer],
      ]),
      viewer,
    ),
    'reply',
  );
  assert.equal(
    classifyNotification(event(1, [['p', viewer]]), viewer),
    'mention',
  );
});

test('a note that does not name you, or another kind, is not a notification', () => {
  assert.equal(
    classifyNotification(event(1, [['p', 'c'.repeat(64)]]), viewer),
    null,
  );
  assert.equal(
    classifyNotification(event(30023, [['p', viewer]]), viewer),
    null,
  );
});

test('the target is the marked reply, else the last e tag, never the root', () => {
  assert.equal(
    notificationTarget(
      event(1, [
        ['e', 'root', '', 'root'],
        ['e', 'parent', '', 'reply'],
        ['e', 'quoted', '', 'mention'],
      ]),
    ),
    'parent',
  );
  assert.equal(
    notificationTarget(
      event(1, [
        ['e', 'root'],
        ['e', 'parent'],
      ]),
    ),
    'parent',
  );
  assert.equal(notificationTarget(event(7, [['p', viewer]])), null);
});

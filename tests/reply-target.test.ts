import assert from 'node:assert/strict';
import test from 'node:test';
import { replyParentOf } from '../src/common/reply-target.js';
import type { NostrEvent } from '../types/nostr';

const ROOT = '1'.repeat(64);
const PARENT = '2'.repeat(64);
const QUOTED = '3'.repeat(64);

function note(tags: string[][]): NostrEvent {
  return {
    id: '9'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: 1,
    created_at: 1,
    tags,
    content: '',
    sig: '',
  } as NostrEvent;
}

test('reply target: the marked reply wins, with its relay hint', () => {
  const parent = replyParentOf(
    note([
      ['e', ROOT, '', 'root'],
      ['e', PARENT, 'wss://relay.example', 'reply'],
    ]),
  );
  assert.deepEqual(parent, { id: PARENT, relays: ['wss://relay.example'] });
});

test('reply target: a direct reply to the root names only the root', () => {
  assert.deepEqual(replyParentOf(note([['e', ROOT, '', 'root']])), {
    id: ROOT,
    relays: [],
  });
});

test('reply target: the positional form takes the last e tag, skipping mentions', () => {
  assert.equal(
    replyParentOf(
      note([
        ['e', ROOT],
        ['e', PARENT],
      ]),
    )?.id,
    PARENT,
  );
  assert.equal(
    replyParentOf(
      note([
        ['e', PARENT],
        ['e', QUOTED, '', 'mention'],
      ]),
    )?.id,
    PARENT,
  );
});

test('reply target: a note that answers nothing', () => {
  assert.equal(replyParentOf(note([])), null);
  assert.equal(replyParentOf(note([['p', 'b'.repeat(64)]])), null);
  assert.equal(replyParentOf(note([['e', QUOTED, '', 'mention']])), null);
  // A bad hint is not a relay to connect to.
  assert.deepEqual(replyParentOf(note([['e', ROOT, 'http://x']])), {
    id: ROOT,
    relays: [],
  });
});

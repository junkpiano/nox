import assert from 'node:assert/strict';
import test from 'node:test';
import {
  descendantsOf,
  eTagMarker,
  replyParentOf,
  threadRootOf,
} from '../src/common/reply-target.js';
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

const AUTHOR = 'b'.repeat(64);

test('reply target: a key in the fourth place is not a marker', () => {
  // Where a NIP-22 comment keeps the parent's author.
  assert.equal(eTagMarker(['e', PARENT, '', AUTHOR]), '');
  assert.equal(eTagMarker(['e', PARENT]), '');
  assert.equal(eTagMarker(['e', ROOT, '', ' Root ']), 'root');
  assert.equal(eTagMarker(['e', PARENT, '', 'reply']), 'reply');
  assert.equal(eTagMarker(['e', QUOTED, '', 'mention']), 'mention');
});

test('reply target: a comment answers the comment its e tag names', () => {
  const comment = {
    ...note([
      ['E', ROOT, '', AUTHOR],
      ['K', '1'],
      ['P', AUTHOR],
      ['e', PARENT, 'wss://relay.example', AUTHOR],
      ['k', '1111'],
      ['p', AUTHOR],
    ]),
    kind: 1111,
  } as NostrEvent;
  assert.deepEqual(replyParentOf(comment), {
    id: PARENT,
    relays: ['wss://relay.example'],
  });
});

function comment(id: string, parent: string): NostrEvent {
  return {
    ...note([
      ['E', ROOT, '', AUTHOR],
      ['K', '1'],
      ['e', parent, '', AUTHOR],
      ['k', parent === ROOT ? '1' : '1111'],
    ]),
    id,
    kind: 1111,
  } as NostrEvent;
}

test('thread root: a comment names its conversation in E', () => {
  assert.equal(threadRootOf(comment(PARENT, ROOT)), ROOT);
});

test('thread root: a kind 1 reply names it with the root marker, or first', () => {
  assert.equal(
    threadRootOf(
      note([
        ['e', ROOT, '', 'root'],
        ['e', PARENT, '', 'reply'],
      ]),
    ),
    ROOT,
  );
  assert.equal(
    threadRootOf(
      note([
        ['e', ROOT],
        ['e', PARENT],
      ]),
    ),
    ROOT,
  );
  assert.equal(threadRootOf(note([])), null);
});

test('descendants: everything under the opened comment, and nothing beside or above it', () => {
  // Post ROOT, comment A on it, B on A, C on B; D is a sibling of A.
  const A = comment('a1'.padEnd(64, '0'), ROOT);
  const B = comment('b1'.padEnd(64, '0'), A.id);
  const C = comment('c1'.padEnd(64, '0'), B.id);
  const D = comment('d1'.padEnd(64, '0'), ROOT);
  const kept = descendantsOf(A.id, [A, B, C, D]).map((event) => event.id);
  assert.deepEqual(kept.sort(), [B.id, C.id].sort());
});

test('descendants: a reply whose parent never arrived is not claimed', () => {
  const A = comment('a2'.padEnd(64, '0'), ROOT);
  const orphan = comment('e2'.padEnd(64, '0'), 'f2'.padEnd(64, '0'));
  assert.deepEqual(descendantsOf(A.id, [A, orphan]), []);
});

test('descendants: a loop of parents ends rather than spinning', () => {
  const X = comment('a3'.padEnd(64, '0'), 'b3'.padEnd(64, '0'));
  const Y = comment('b3'.padEnd(64, '0'), 'a3'.padEnd(64, '0'));
  assert.deepEqual(descendantsOf(ROOT, [X, Y]), []);
});

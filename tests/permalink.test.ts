import assert from 'node:assert/strict';
import test from 'node:test';
import { nip19 } from 'nostr-tools';
import { eventId, eventLink } from '../src/common/permalink.js';

const post = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 1 };

test('the ID is an nevent carrying the id, author and kind', () => {
  const decoded = nip19.decode(eventId(post));
  assert.equal(decoded.type, 'nevent');
  const data = decoded.data as { id: string; author?: string; kind?: number };
  assert.deepEqual(
    [data.id, data.author, data.kind],
    [post.id, post.pubkey, 1],
  );
});

test('the link is that ID on nox.garden', () => {
  assert.equal(eventLink(post), `https://nox.garden/${eventId(post)}`);
});

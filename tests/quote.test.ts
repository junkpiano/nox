/**
 * Quoting a post: what NIP-18 asks of the event, so other clients see a
 * quote and draw the quoted post as a card.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { nip19 } from 'nostr-tools';
import {
  quoteContent,
  quoteReference,
  quoteTags,
} from '../src/common/quote.js';
import type { NostrEvent } from '../types/nostr';

const quoted = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1,
  kind: 1,
  tags: [],
  content: 'original',
  sig: 'c'.repeat(128),
} as unknown as NostrEvent;

test('a quote names the post with a q tag and tells its author with a p tag', () => {
  assert.deepEqual(quoteTags(quoted), [
    ['q', quoted.id, '', quoted.pubkey],
    ['p', quoted.pubkey],
  ]);
});

test('the reference is an nevent carrying the id, author and kind', () => {
  const ref: string = quoteReference(quoted);
  assert.ok(ref.startsWith('nostr:nevent1'));
  const decoded = nip19.decode(ref.slice('nostr:'.length));
  assert.equal(decoded.type, 'nevent');
  const data = decoded.data as { id: string; author?: string; kind?: number };
  assert.equal(data.id, quoted.id);
  assert.equal(data.author, quoted.pubkey);
  assert.equal(data.kind, 1);
});

test('the content is the words, then the reference, blank parts dropped', () => {
  const content: string = quoteContent(['  hello  ', ''], quoted);
  assert.equal(content, `hello\n\n${quoteReference(quoted)}`);
  assert.equal(quoteContent([''], quoted), quoteReference(quoted));
});

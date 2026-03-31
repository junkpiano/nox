import test from 'node:test';
import assert from 'node:assert/strict';
import type { NostrEvent, PubkeyHex } from '../types/nostr';
import {
  applyOptimisticReactionState,
  filterDeletedReactionEvents,
  findOwnReactionEvents,
  getNextReactionDetailsState,
  isReactionClickOnly,
  mergeReactionEvents,
} from '../src/common/reaction-interactions.js';

function createReactionEvent(options: {
  id: string;
  pubkey: PubkeyHex;
  targetEventId: string;
  content: string;
  createdAt?: number;
}): NostrEvent {
  return {
    id: options.id,
    pubkey: options.pubkey,
    created_at: options.createdAt ?? 1,
    kind: 7,
    tags: [['e', options.targetEventId]],
    content: options.content,
    sig: 'sig',
  };
}

function createDeleteEvent(options: {
  id: string;
  pubkey: PubkeyHex;
  deletedEventId: string;
  createdAt?: number;
}): NostrEvent {
  return {
    id: options.id,
    pubkey: options.pubkey,
    created_at: options.createdAt ?? 1,
    kind: 5,
    tags: [['e', options.deletedEventId]],
    content: '',
    sig: 'sig',
  };
}

test('getNextReactionDetailsState opens details for a newly clicked reaction', () => {
  assert.deepEqual(getNextReactionDetailsState(null, 'text:❤'), {
    isOpen: true,
    reactionKey: 'text:❤',
  });
});

test('getNextReactionDetailsState closes details when clicking the same reaction again', () => {
  assert.deepEqual(getNextReactionDetailsState('text:❤', 'text:❤'), {
    isOpen: false,
    reactionKey: null,
  });
});

test('getNextReactionDetailsState switches details when a different reaction is clicked', () => {
  assert.deepEqual(getNextReactionDetailsState('text:❤', 'text:👍'), {
    isOpen: true,
    reactionKey: 'text:👍',
  });
});

test('reaction interactions use click-only details instead of hover previews', () => {
  assert.equal(isReactionClickOnly(), true);
});

test('findOwnReactionEvents returns the viewers existing heart reactions for the target event', () => {
  const viewerPubkey: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
  const targetEventId = 'event-1';
  const events: NostrEvent[] = [
    createReactionEvent({
      id: 'reaction-1',
      pubkey: viewerPubkey,
      targetEventId,
      content: '❤',
      createdAt: 10,
    }),
    createReactionEvent({
      id: 'reaction-2',
      pubkey: viewerPubkey,
      targetEventId,
      content: '❤',
      createdAt: 20,
    }),
  ];

  assert.deepEqual(
    findOwnReactionEvents(events, viewerPubkey, targetEventId, 'text:❤').map(
      (event: NostrEvent): string => event.id,
    ),
    ['reaction-2', 'reaction-1'],
  );
});

test('findOwnReactionEvents ignores reactions from other users, events, or emoji', () => {
  const viewerPubkey: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
  const otherPubkey: PubkeyHex = 'b'.repeat(64) as PubkeyHex;
  const targetEventId = 'event-1';
  const events: NostrEvent[] = [
    createReactionEvent({
      id: 'other-user',
      pubkey: otherPubkey,
      targetEventId,
      content: '❤',
      createdAt: 30,
    }),
    createReactionEvent({
      id: 'other-event',
      pubkey: viewerPubkey,
      targetEventId: 'event-2',
      content: '❤',
      createdAt: 20,
    }),
    createReactionEvent({
      id: 'other-reaction',
      pubkey: viewerPubkey,
      targetEventId,
      content: '👍',
      createdAt: 10,
    }),
  ];

  assert.deepEqual(
    findOwnReactionEvents(events, viewerPubkey, targetEventId, 'text:❤'),
    [],
  );
});

test('mergeReactionEvents keeps optimistic reactions available before relays catch up', () => {
  const optimistic: NostrEvent = createReactionEvent({
    id: 'optimistic-reaction',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
    createdAt: 50,
  });

  assert.deepEqual(
    mergeReactionEvents([], [optimistic]).map(
      (event: NostrEvent): string => event.id,
    ),
    ['optimistic-reaction'],
  );
});

test('mergeReactionEvents de-duplicates by event id and keeps newest first', () => {
  const older: NostrEvent = createReactionEvent({
    id: 'same-id',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
    createdAt: 10,
  });
  const newer: NostrEvent = createReactionEvent({
    id: 'same-id',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
    createdAt: 20,
  });
  const another: NostrEvent = createReactionEvent({
    id: 'another-id',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
    createdAt: 15,
  });

  assert.deepEqual(
    mergeReactionEvents([older, another], [newer]).map(
      (event: NostrEvent): string => event.id,
    ),
    ['same-id', 'another-id'],
  );
});

test('applyOptimisticReactionState removes deleted reaction ids from the displayed set', () => {
  const relayReaction: NostrEvent = createReactionEvent({
    id: 'relay-reaction',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
    createdAt: 10,
  });
  const optimisticReaction: NostrEvent = createReactionEvent({
    id: 'optimistic-reaction',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '👍',
    createdAt: 20,
  });

  assert.deepEqual(
    applyOptimisticReactionState(
      [relayReaction],
      [optimisticReaction],
      new Set(['relay-reaction']),
    ).map((event: NostrEvent): string => event.id),
    ['optimistic-reaction'],
  );
});

test('filterDeletedReactionEvents removes a reaction deleted by the same author', () => {
  const pubkey: PubkeyHex = 'a'.repeat(64) as PubkeyHex;
  const reaction: NostrEvent = createReactionEvent({
    id: 'reaction-1',
    pubkey,
    targetEventId: 'event-1',
    content: '❤',
  });
  const deletion: NostrEvent = createDeleteEvent({
    id: 'delete-1',
    pubkey,
    deletedEventId: 'reaction-1',
  });

  assert.deepEqual(filterDeletedReactionEvents([reaction], [deletion]), []);
});

test('filterDeletedReactionEvents ignores delete events from a different author', () => {
  const reaction: NostrEvent = createReactionEvent({
    id: 'reaction-1',
    pubkey: 'a'.repeat(64) as PubkeyHex,
    targetEventId: 'event-1',
    content: '❤',
  });
  const deletion: NostrEvent = createDeleteEvent({
    id: 'delete-1',
    pubkey: 'b'.repeat(64) as PubkeyHex,
    deletedEventId: 'reaction-1',
  });

  assert.deepEqual(
    filterDeletedReactionEvents([reaction], [deletion]).map(
      (event: NostrEvent): string => event.id,
    ),
    ['reaction-1'],
  );
});

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { replaceEmojiShortcodes } from '../utils/utils.js';

export interface ReactionAggregate {
  count: number;
  key: string;
  content: string;
  shortcode?: string;
  imageUrl?: string;
}

export interface ReactionDetailsState {
  isOpen: boolean;
  reactionKey: string | null;
}

export function isReactionClickOnly(): boolean {
  return true;
}

function getEmojiTagMap(tags: string[][]): Map<string, string> {
  const emojiMap: Map<string, string> = new Map();
  tags.forEach((tag: string[]): void => {
    if (
      tag[0] !== 'emoji' ||
      tag.length < 3 ||
      !tag[1] ||
      !tag[2] ||
      !tag[1].trim() ||
      !tag[2].trim()
    ) {
      return;
    }
    emojiMap.set(tag[1].trim().toLowerCase(), tag[2].trim());
  });
  return emojiMap;
}

function getTargetEventId(event: NostrEvent): string | null {
  const eTag: string[] | undefined = event.tags.find(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  return eTag?.[1] || null;
}

export function normalizeReaction(content: string | undefined): string {
  const trimmed: string = replaceEmojiShortcodes(content || '').trim();
  return trimmed ? trimmed : '❤';
}

export function getReactionAggregate(
  content: string | undefined,
  tags: string[][],
): ReactionAggregate {
  const normalizedContent: string = normalizeReaction(content);
  const customMatch: RegExpMatchArray | null =
    normalizedContent.match(/^:([a-z0-9_]+):$/i);
  const shortcodeMatch: string | undefined = customMatch?.[1];
  if (shortcodeMatch) {
    const shortcode: string = shortcodeMatch;
    const emojiTagMap: Map<string, string> = getEmojiTagMap(tags);
    const imageUrl: string | undefined = emojiTagMap.get(
      shortcode.toLowerCase(),
    );
    if (imageUrl) {
      return {
        count: 1,
        key: `custom:${shortcode.toLowerCase()}:${imageUrl}`,
        content: `:${shortcode}:`,
        shortcode,
        imageUrl,
      };
    }
  }
  return {
    count: 1,
    key: `text:${normalizedContent}`,
    content: normalizedContent,
  };
}

export function getNextReactionDetailsState(
  currentReactionKey: string | null,
  clickedReactionKey: string,
): ReactionDetailsState {
  if (currentReactionKey === clickedReactionKey) {
    return {
      isOpen: false,
      reactionKey: null,
    };
  }
  return {
    isOpen: true,
    reactionKey: clickedReactionKey,
  };
}

export function findOwnReactionEvents(
  events: NostrEvent[],
  viewerPubkey: PubkeyHex,
  targetEventId: string,
  reactionKey: string,
): NostrEvent[] {
  return events
    .filter((event: NostrEvent): boolean => {
      if (event.kind !== 7 || event.pubkey !== viewerPubkey) {
        return false;
      }
      if (getTargetEventId(event) !== targetEventId) {
        return false;
      }
      return getReactionAggregate(event.content, event.tags).key === reactionKey;
    })
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at);
}

export function mergeReactionEvents(
  primaryEvents: NostrEvent[],
  secondaryEvents: NostrEvent[],
): NostrEvent[] {
  const mergedById: Map<string, NostrEvent> = new Map();

  [...primaryEvents, ...secondaryEvents].forEach((event: NostrEvent): void => {
    const existing: NostrEvent | undefined = mergedById.get(event.id);
    if (!existing || event.created_at >= existing.created_at) {
      mergedById.set(event.id, event);
    }
  });

  return Array.from(mergedById.values()).sort(
    (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
  );
}

export function applyOptimisticReactionState(
  relayEvents: NostrEvent[],
  optimisticEvents: NostrEvent[],
  removedReactionIds: Set<string>,
): NostrEvent[] {
  return mergeReactionEvents(relayEvents, optimisticEvents).filter(
    (event: NostrEvent): boolean => !removedReactionIds.has(event.id),
  );
}

export function filterDeletedReactionEvents(
  reactionEvents: NostrEvent[],
  deletionEvents: NostrEvent[],
): NostrEvent[] {
  const reactionAuthorById: Map<string, PubkeyHex> = new Map();
  reactionEvents.forEach((reactionEvent: NostrEvent): void => {
    reactionAuthorById.set(reactionEvent.id, reactionEvent.pubkey as PubkeyHex);
  });

  const deletedReactionIds: Set<string> = new Set();
  deletionEvents.forEach((deletionEvent: NostrEvent): void => {
    if (deletionEvent.kind !== 5) {
      return;
    }
    deletionEvent.tags.forEach((tag: string[]): void => {
      if (tag[0] !== 'e' || !tag[1]) {
        return;
      }
      const reactionAuthor: PubkeyHex | undefined = reactionAuthorById.get(
        tag[1],
      );
      if (!reactionAuthor || reactionAuthor !== deletionEvent.pubkey) {
        return;
      }
      deletedReactionIds.add(tag[1]);
    });
  });

  return reactionEvents.filter(
    (reactionEvent: NostrEvent): boolean =>
      !deletedReactionIds.has(reactionEvent.id),
  );
}

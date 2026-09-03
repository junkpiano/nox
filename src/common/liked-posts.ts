/**
 * The posts you liked.
 *
 * Your kind 7s name them, one `e` tag each. Reading the list back is three
 * questions to the relays - your reactions, your own deletions of any of
 * them, the posts they point at - and one decision made here: which
 * reactions still stand, and one row per post however many times it was
 * reacted to. Both apps draw from this; the screen is the only difference.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { filterDeletedReactionEvents } from './reaction-interactions.js';
import { queryRelays } from './relay-query.js';

export interface Like {
  /** The reaction itself; its time orders the list. */
  reaction: NostrEvent;
  /** The post it names. */
  targetId: string;
  /** Who wrote that post, when the reaction says. */
  targetAuthor: PubkeyHex | null;
}

/**
 * The reactions that still stand, one per post, newest first.
 *
 * A kind 7 the author later withdrew with a kind 5 is gone; a post reacted
 * to twice appears once, under the later reaction. Anything that is not a
 * reaction, or names no post, is ignored.
 */
export function collectLikes(
  reactions: NostrEvent[],
  deletions: NostrEvent[],
): Like[] {
  const standing: NostrEvent[] = filterDeletedReactionEvents(
    reactions.filter((event: NostrEvent): boolean => event.kind === 7),
    deletions,
  );
  const byTarget: Map<string, Like> = new Map();
  for (const reaction of standing) {
    const targetId: string | undefined = reaction.tags.find(
      (tag: string[]): boolean => tag[0] === 'e' && !!tag[1],
    )?.[1];
    if (!targetId) continue;
    const targetAuthor: string | undefined = reaction.tags.find(
      (tag: string[]): boolean => tag[0] === 'p' && !!tag[1],
    )?.[1];
    const previous: Like | undefined = byTarget.get(targetId);
    if (previous && previous.reaction.created_at >= reaction.created_at) {
      continue;
    }
    byTarget.set(targetId, {
      reaction,
      targetId,
      targetAuthor: (targetAuthor as PubkeyHex | undefined) ?? null,
    });
  }
  return Array.from(byTarget.values()).sort(
    (a: Like, b: Like): number => b.reaction.created_at - a.reaction.created_at,
  );
}

/** Your likes, as the relays remember them. */
export async function fetchLikes(
  viewer: PubkeyHex,
  relays: string[],
  limit: number = 100,
): Promise<Like[]> {
  const reactions: NostrEvent[] = await queryRelays(relays, {
    kinds: [7],
    authors: [viewer],
    limit,
  });
  if (reactions.length === 0) return [];
  const deletions: NostrEvent[] = await queryRelays(relays, {
    kinds: [5],
    authors: [viewer],
    '#e': reactions.map((event: NostrEvent): string => event.id),
    limit: Math.max(50, reactions.length * 2),
  });
  return collectLikes(reactions, deletions).slice(0, limit);
}

/**
 * The posts the likes name, in the order of the likes. A post no relay has
 * any more is left out rather than shown as a blank.
 */
export async function fetchLikedEvents(
  likes: Like[],
  relays: string[],
): Promise<NostrEvent[]> {
  const ids: string[] = likes.map((like: Like): string => like.targetId);
  if (ids.length === 0) return [];
  const found: Map<string, NostrEvent> = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    const chunk: string[] = ids.slice(index, index + 100);
    const events: NostrEvent[] = await queryRelays(relays, { ids: chunk });
    for (const event of events) found.set(event.id, event);
  }
  return ids
    .map((id: string): NostrEvent | undefined => found.get(id))
    .filter((event: NostrEvent | undefined): event is NostrEvent => !!event);
}

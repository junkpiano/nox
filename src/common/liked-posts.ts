/**
 * The posts you liked.
 *
 * Your kind 7s name them, one `e` tag each. Reading the list back is three
 * questions to the relays - your reactions, your own deletions of any of
 * them, the posts they point at - and one decision made here: which
 * reactions still stand, and one row per post however many times it was
 * reacted to. Both apps draw from this; the screen is the only difference.
 *
 * Nothing a relay sends is taken at its word. A reaction is yours only if
 * it is signed by your key; a deletion withdraws one only if it is signed by
 * your key; a post is shown only if it is signed by whoever it names and is
 * one that was asked for. A relay that answers with a kind 7 carrying your
 * pubkey and somebody else's signature is answering with a lie, and the
 * lie would otherwise put a post under "Likes" that you never liked.
 */

import { verifyEvent } from 'nostr-tools';
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

/** Signed by the key it claims. */
function genuine(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

/** Genuine, of this kind, and written by this person. */
function ownGenuine(
  events: NostrEvent[],
  kind: number,
  author: PubkeyHex,
): NostrEvent[] {
  return events.filter(
    (event: NostrEvent): boolean =>
      event.kind === kind && event.pubkey === author && genuine(event),
  );
}

/**
 * The reactions that still stand, one per post, newest first.
 *
 * Only your own, genuinely signed kind 7s count, and only your own,
 * genuinely signed kind 5s withdraw one. A post reacted to twice appears
 * once, under the later reaction. Anything that names no post is ignored.
 */
export function collectLikes(
  viewer: PubkeyHex,
  reactions: NostrEvent[],
  deletions: NostrEvent[],
): Like[] {
  const standing: NostrEvent[] = filterDeletedReactionEvents(
    ownGenuine(reactions, 7, viewer),
    ownGenuine(deletions, 5, viewer),
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

/**
 * The posts the likes name, in the order of the likes.
 *
 * Only a genuine post that was actually asked for is kept: a relay may
 * answer an `ids` query with anything, and an id that is not on the list,
 * or a body whose signature does not match its author, is not a post you
 * liked. A post no relay has any more is left out rather than shown blank.
 */
export function selectLikedEvents(
  likes: Like[],
  candidates: NostrEvent[],
): NostrEvent[] {
  const wanted: Set<string> = new Set(
    likes.map((like: Like): string => like.targetId),
  );
  const found: Map<string, NostrEvent> = new Map();
  for (const event of candidates) {
    if (!wanted.has(event.id) || found.has(event.id)) continue;
    if (!genuine(event)) continue;
    found.set(event.id, event);
  }
  return likes
    .map((like: Like): NostrEvent | undefined => found.get(like.targetId))
    .filter((event: NostrEvent | undefined): event is NostrEvent => !!event);
}

/** Your likes, as the relays remember them, believed only where signed. */
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
  return collectLikes(viewer, reactions, deletions).slice(0, limit);
}

/** The posts the likes name, fetched in chunks and judged before shown. */
export async function fetchLikedEvents(
  likes: Like[],
  relays: string[],
): Promise<NostrEvent[]> {
  const ids: string[] = likes.map((like: Like): string => like.targetId);
  if (ids.length === 0) return [];
  const candidates: NostrEvent[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk: string[] = ids.slice(index, index + 100);
    candidates.push(...(await queryRelays(relays, { ids: chunk })));
  }
  return selectLikedEvents(likes, candidates);
}

/**
 * Reading a repost.
 *
 * NIP-18 puts the whole reposted event, as JSON, in the `content` of a kind 6
 * - so a client that renders `content` as text shows the reader a wall of
 * `{"id":"...","sig":"..."}`. That is not a rendering quirk to be styled
 * around: the text of a repost is not text.
 *
 * The embedded copy is not always there. Some clients publish an empty
 * `content` and leave only the `e` tag, so both are reported and the caller
 * decides whether an id alone is worth a relay round trip.
 *
 * Nothing here trusts the embedded copy any further than it has to. It arrived
 * inside somebody else's event and its signature is not checked at this layer,
 * so it is treated as a claim about what was reposted - fine for showing, and
 * the reason a reply or a reaction is addressed to the id rather than to
 * whatever the blob says about itself.
 */

import type { NostrEvent } from '../../types/nostr';

/** kind 6 is a repost; kind 16 is a generic repost of a non-kind-1 event. */
export const REPOST_KINDS: ReadonlySet<number> = new Set([6, 16]);

export interface RepostTarget {
  /** The reposted event, when the repost carried a copy of it. */
  event: NostrEvent | null;
  /** The reposted event's id, from the copy or from the `e` tag. */
  eventId: string | null;
}

function looksLikeEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<NostrEvent>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.pubkey === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.created_at === 'number' &&
    Array.isArray(candidate.tags)
  );
}

/** The last `e` tag, which is where NIP-18 puts the reposted event. */
function taggedEventId(event: NostrEvent): string | null {
  for (let index = event.tags.length - 1; index >= 0; index -= 1) {
    const tag: string[] | undefined = event.tags[index];
    if (tag && tag[0] === 'e' && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

export function isRepost(event: NostrEvent): boolean {
  return REPOST_KINDS.has(event.kind);
}

/**
 * What a repost is pointing at.
 *
 * Returns nulls rather than throwing for anything that is not a readable
 * repost: a malformed one should render as an unremarkable empty card, not
 * take the timeline down.
 */
export function readRepost(event: NostrEvent): RepostTarget {
  if (!isRepost(event)) {
    return { event: null, eventId: null };
  }

  const tagged: string | null = taggedEventId(event);

  if (!event.content.trim()) {
    return { event: null, eventId: tagged };
  }

  try {
    const parsed: unknown = JSON.parse(event.content);
    if (looksLikeEvent(parsed)) {
      return { event: parsed, eventId: parsed.id };
    }
  } catch {
    // Not JSON. Some clients put a comment there instead, which is not what
    // the spec says but is not worth losing the repost over.
  }

  return { event: null, eventId: tagged };
}

export interface UnwrappedRepost {
  /** The event to show: the reposted note when there is a copy, else null. */
  event: NostrEvent | null;
  /** Who passed it on; null when the input was not a repost. */
  repostedBy: string | null;
  /** The reposted event's id, for fetching when there was no copy. */
  targetId: string | null;
}

/**
 * The one rule for a repost, wherever it is drawn.
 *
 * A kind:6's `content` is never body text - it is the reposted event
 * serialised, and drawing it as text puts a card full of `{"id":...}` in
 * front of the reader. The timeline knew this; the thread screen, the quote
 * card and the notification row each read `content` directly and did not.
 * Every path goes through here now: a repost resolves to the event inside
 * it, or to an id to fetch, and never to its own content.
 *
 * A non-repost passes through unchanged, so callers can apply this without
 * first asking what they have.
 */
export function unwrapRepost(event: NostrEvent): UnwrappedRepost {
  if (!isRepost(event)) {
    return { event, repostedBy: null, targetId: null };
  }
  const target: RepostTarget = readRepost(event);
  return {
    event: target.event,
    repostedBy: event.pubkey,
    targetId: target.eventId,
  };
}

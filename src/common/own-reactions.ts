/**
 * Which of the posts on screen you have already liked or reposted.
 *
 * A card draws its ♡ from this. Without it every card started empty, so a
 * post liked yesterday - or liked a minute ago on another screen - offered
 * to be liked again, and a tap made a second kind 7 the relays already had
 * one of.
 *
 * One question per screen, not per card: a filter takes a list of `e`
 * tags, so everyone's worth of posts costs one subscription. The answer is
 * remembered for a while in a book, the way statuses are, and a like made
 * from the app is written into the book at once rather than waited for.
 *
 * Nothing a relay sends is taken at its word. A reaction is yours only if
 * your key signed it, and only your own signed kind 5 withdraws one - the
 * same rules `liked-posts.ts` applies to the Likes page.
 */

import { verifyEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { filterDeletedReactionEvents } from './reaction-interactions.js';
import {
  NoRelayAnsweredError,
  queryRelays,
  queryRelaysDetailed,
  type SubscriptionOpener,
} from './relay-query.js';

export interface OwnReactions {
  /** Ids of the posts you have a standing kind 7 on. */
  liked: Set<string>;
  /** Ids of the posts you have a standing kind 6 on. */
  reposted: Set<string>;
}

export type Reaction = 'like' | 'repost';

/** Relays reject enormous tag lists; this many ids per question. */
const IDS_PER_QUERY: number = 100;

function genuine(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

function targetOf(event: NostrEvent): string | null {
  const tag: string[] | undefined = event.tags.find(
    (candidate: string[]): boolean => candidate[0] === 'e' && !!candidate[1],
  );
  return tag?.[1] ?? null;
}

/**
 * The posts among `ids` you reacted to, judged from what the relays sent.
 *
 * Only your own, genuinely signed kind 6s and 7s count, and only your own,
 * genuinely signed kind 5s withdraw one. A reaction naming a post that was
 * not asked about is ignored: a relay may answer a `#e` filter with
 * anything, and a post you did not ask about is not on this screen.
 */
export function collectOwnReactions(
  viewer: PubkeyHex,
  ids: Iterable<string>,
  events: NostrEvent[],
  deletions: NostrEvent[],
): OwnReactions {
  const wanted: Set<string> = new Set(ids);
  const own: NostrEvent[] = events.filter(
    (event: NostrEvent): boolean =>
      (event.kind === 6 || event.kind === 7) &&
      event.pubkey === viewer &&
      genuine(event),
  );
  const standing: NostrEvent[] = filterDeletedReactionEvents(
    own,
    deletions.filter(
      (event: NostrEvent): boolean =>
        event.kind === 5 && event.pubkey === viewer && genuine(event),
    ),
  );
  const liked: Set<string> = new Set();
  const reposted: Set<string> = new Set();
  for (const event of standing) {
    const target: string | null = targetOf(event);
    if (!target || !wanted.has(target)) continue;
    (event.kind === 7 ? liked : reposted).add(target);
  }
  return { liked, reposted };
}

export type OwnReactionLookup = (
  viewer: PubkeyHex,
  ids: string[],
  relays: string[],
) => Promise<OwnReactions>;

/**
 * Asks the relays which of these posts you reacted to.
 *
 * Throws `NoRelayAnsweredError` when no relay answered about the reactions:
 * "you liked none of these" cannot be learned from a dead connection. The
 * follow-up question about deletions is allowed to go unanswered - a
 * reaction the relays have is shown as standing until one says otherwise,
 * which is also what the Likes page does.
 */
export async function fetchOwnReactions(
  viewer: PubkeyHex,
  ids: string[],
  relays: string[],
  open?: SubscriptionOpener,
): Promise<OwnReactions> {
  const wanted: string[] = Array.from(new Set(ids));
  if (wanted.length === 0) {
    return { liked: new Set(), reposted: new Set() };
  }
  if (relays.length === 0) {
    throw new NoRelayAnsweredError(relays);
  }

  const reactions: NostrEvent[] = [];
  for (let index = 0; index < wanted.length; index += IDS_PER_QUERY) {
    const chunk: string[] = wanted.slice(index, index + IDS_PER_QUERY);
    const { events, answered } = await queryRelaysDetailed(
      relays,
      { kinds: [6, 7], authors: [viewer], '#e': chunk },
      open,
    );
    if (answered === 0) {
      throw new NoRelayAnsweredError(relays);
    }
    reactions.push(...events);
  }

  let deletions: NostrEvent[] = [];
  if (reactions.length > 0) {
    deletions = await queryRelays(
      relays,
      {
        kinds: [5],
        authors: [viewer],
        '#e': reactions.map((event: NostrEvent): string => event.id),
        limit: Math.max(50, reactions.length * 2),
      },
      open,
    );
  }

  return collectOwnReactions(viewer, wanted, reactions, deletions);
}

/**
 * How long an answer is believed before a post is asked about again.
 *
 * A like made elsewhere is a rare thing to catch mid-session; the reason
 * to ask again at all is a like withdrawn on another client, and a few
 * minutes is soon enough for that.
 */
export const REACTION_ANSWER_TTL_SECONDS: number = 5 * 60;

export type Clock = () => number;

const wallClock: Clock = (): number => Math.floor(Date.now() / 1000);

export interface ReactionBook {
  /**
   * Asks about the posts not yet asked about, or asked about long enough
   * ago, and resolves with everything the book knows for this viewer.
   */
  ask(
    viewer: PubkeyHex,
    ids: string[],
    relays: string[],
  ): Promise<OwnReactions>;
  /** What the book knows now, without asking anyone. */
  known(viewer: PubkeyHex): OwnReactions;
  /**
   * Writes a reaction the app just made. The relays have it now, and a
   * screen should not have to ask them to find out.
   */
  mark(viewer: PubkeyHex, id: string, reaction: Reaction): void;
  /** Takes back a reaction the app just deleted. */
  unmark(viewer: PubkeyHex, id: string, reaction: Reaction): void;
}

/**
 * One book for one viewer at a time. Everything in it is about whose key
 * signed what, so a different key is a different book: the old one is
 * dropped the moment another viewer asks.
 */
export function createReactionBook(
  lookup: OwnReactionLookup = fetchOwnReactions,
  clock: Clock = wallClock,
): ReactionBook {
  let owner: PubkeyHex | null = null;
  const askedAt: Map<string, number> = new Map();
  const liked: Set<string> = new Set();
  const reposted: Set<string> = new Set();
  const pending: Map<string, Promise<void>> = new Map();

  const belongsTo = (viewer: PubkeyHex): void => {
    if (owner === viewer) return;
    owner = viewer;
    askedAt.clear();
    liked.clear();
    reposted.clear();
    pending.clear();
  };

  const snapshot = (): OwnReactions => ({
    liked: new Set(liked),
    reposted: new Set(reposted),
  });

  const lookUp = async (
    viewer: PubkeyHex,
    fresh: string[],
    relays: string[],
  ): Promise<void> => {
    try {
      const found: OwnReactions = await lookup(viewer, fresh, relays);
      if (owner !== viewer) return;
      // An answer replaces what was held for these posts, including with
      // nothing: a like withdrawn elsewhere is not a like now.
      for (const id of fresh) {
        if (found.liked.has(id)) liked.add(id);
        else liked.delete(id);
        if (found.reposted.has(id)) reposted.add(id);
        else reposted.delete(id);
      }
    } catch {
      // Nobody answered. That is not knowledge about any of these.
      if (owner === viewer) for (const id of fresh) askedAt.delete(id);
    } finally {
      if (owner === viewer) for (const id of fresh) pending.delete(id);
    }
  };

  return {
    async ask(viewer, ids, relays) {
      belongsTo(viewer);
      const now: number = clock();
      const wanted: string[] = Array.from(new Set(ids));
      const fresh: string[] = wanted.filter((id: string): boolean => {
        if (pending.has(id)) return false;
        const at: number | undefined = askedAt.get(id);
        return at === undefined || now - at >= REACTION_ANSWER_TTL_SECONDS;
      });
      if (fresh.length > 0) {
        for (const id of fresh) askedAt.set(id, now);
        const flight: Promise<void> = lookUp(viewer, fresh, relays);
        for (const id of fresh) pending.set(id, flight);
      }
      await Promise.all(
        Array.from(
          new Set(
            wanted
              .map((id: string) => pending.get(id))
              .filter(
                (flight): flight is Promise<void> => flight !== undefined,
              ),
          ),
        ),
      );
      return snapshot();
    },
    known(viewer) {
      belongsTo(viewer);
      return snapshot();
    },
    mark(viewer, id, reaction) {
      belongsTo(viewer);
      (reaction === 'like' ? liked : reposted).add(id);
      // Fresh knowledge; no need to ask about this post for a while.
      askedAt.set(id, clock());
    },
    unmark(viewer, id, reaction) {
      belongsTo(viewer);
      (reaction === 'like' ? liked : reposted).delete(id);
      askedAt.set(id, clock());
    },
  };
}

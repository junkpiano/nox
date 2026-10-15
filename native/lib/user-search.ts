/**
 * Finding people, on the shared ranking.
 *
 * The ranking, the identifier decoding and the relay list all come from
 * `src/features/search/user-ranking.ts` - the same code the web app ranks
 * with, split out of `user-search.ts` for exactly this. Importing that module
 * whole would drag in `event-render.ts` and its 2,321 lines of DOM.
 *
 * The fetching is shared too (`user-query.ts`); what is here is putting the
 * two together for the screen.
 */

import { fetchFollowList } from '../../src/common/events-queries';
import { getRelays } from '../../src/features/relays/relays';
import { fetchUserSearchHits } from '../../src/features/search/user-query';
import {
  rankUserResults,
  SEARCH_RELAYS,
  type UserSearchResult,
} from '../../src/features/search/user-ranking';
import type { PubkeyHex } from '../../types/nostr';

/**
 * Deliberately far more than are shown: the relay orders by edit recency, so a
 * narrow ask returns a narrow slice of "recently edited" and the ranking has
 * nothing better to promote out of it.
 */
const SEARCH_LIMIT: number = 100;

export interface UserSearchOutcome {
  results: UserSearchResult[];
  /** How long the whole thing took, for the same reason the timelines report it. */
  ms: number;
}

/**
 * The viewer's follows, or an empty set.
 *
 * Ranking degrades rather than fails without it: everyone simply falls through
 * to the name and NIP-05 tiers.
 */
async function loadFollowedSet(
  viewer: PubkeyHex | null,
): Promise<Set<PubkeyHex>> {
  if (!viewer) return new Set<PubkeyHex>();
  try {
    return new Set<PubkeyHex>(await fetchFollowList(viewer, getRelays()));
  } catch {
    return new Set<PubkeyHex>();
  }
}

export async function searchUsers(
  query: string,
  viewer: PubkeyHex | null,
): Promise<UserSearchOutcome> {
  const started: number = Date.now();

  // The follow list is fetched alongside the search, not before it: ranking
  // wants it, but a slow kind 3 must not delay the query.
  const [raw, followed] = await Promise.all([
    fetchUserSearchHits(query, SEARCH_RELAYS, SEARCH_LIMIT),
    loadFollowedSet(viewer),
  ]);

  return {
    results: rankUserResults(raw, query, followed),
    ms: Date.now() - started,
  };
}

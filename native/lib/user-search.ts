/**
 * Finding people, on the shared ranking.
 *
 * The ranking, the identifier decoding and the relay list all come from
 * `src/features/search/user-ranking.ts` - the same code the web app ranks
 * with, split out of `user-search.ts` for exactly this. Importing that module
 * whole would drag in `event-render.ts` and its 2,321 lines of DOM.
 *
 * What is native here is only the fetching, which goes through the shared
 * relay layer rather than opening its own sockets.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { fetchFollowList } from '../../src/common/events-queries';
import { openRelaySubscription } from '../../src/common/relay-socket';
import { getRelays } from '../../src/features/relays/relays';
import {
  parseProfileContent,
  rankUserResults,
  SEARCH_RELAYS,
  type UserSearchResult,
} from '../../src/features/search/user-ranking';

/**
 * Deliberately far more than are shown: the relay orders by edit recency, so a
 * narrow ask returns a narrow slice of "recently edited" and the ranking has
 * nothing better to promote out of it.
 */
const SEARCH_LIMIT: number = 100;
const TIMEOUT_MS: number = 8000;

export interface UserSearchOutcome {
  results: UserSearchResult[];
  /** How long the whole thing took, for the same reason the timelines report it. */
  ms: number;
}

function searchRelays(query: string): Promise<UserSearchResult[]> {
  return new Promise<UserSearchResult[]>((resolve) => {
    // Keyed by pubkey: a person has one profile, and two relays holding
    // different revisions of it must not become two rows.
    const byPubkey: Map<PubkeyHex, UserSearchResult> = new Map();
    const stops: Array<() => void> = [];
    let done: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Already gone.
        }
      }
      resolve(Array.from(byPubkey.values()));
    };

    const timer = setTimeout(finish, TIMEOUT_MS);
    const oneDone = (): void => {
      done += 1;
      if (done >= SEARCH_RELAYS.length) finish();
    };

    for (const relayUrl of SEARCH_RELAYS) {
      openRelaySubscription(
        relayUrl,
        { kinds: [0], search: query, limit: SEARCH_LIMIT },
        {
          onEvent: (event: NostrEvent): void => {
            if (event.kind !== 0 || !event.pubkey) return;
            const pubkey = event.pubkey as PubkeyHex;
            const existing = byPubkey.get(pubkey);
            if (existing && existing.createdAt >= event.created_at) return;
            const profile = parseProfileContent(event.content);
            if (!profile) return;
            byPubkey.set(pubkey, {
              pubkey,
              npub: '' as UserSearchResult['npub'],
              profile,
              createdAt: event.created_at,
            });
          },
          onEose: oneDone,
          onClosed: oneDone,
        },
      )
        .then((stop: () => void): void => {
          stops.push(stop);
        })
        .catch(oneDone);
    }
  });
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
    searchRelays(query),
    loadFollowedSet(viewer),
  ]);

  return {
    results: rankUserResults(raw, query, followed),
    ms: Date.now() - started,
  };
}

/**
 * Asking search relays for people: the fetching half of user search, shared
 * by the web and the phone. Ranking is `user-ranking.ts`; drawing the rows is
 * each front end's.
 *
 * Through the shared relay layer, so a search relay gets the same connection
 * reuse, AUTH and event verification as every other query.
 */
import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../../types/nostr';
import { isMuted } from '../../common/mute-state.js';
import {
  clearRelayTimeout,
  setRelayTimeout,
} from '../../common/relay-schedule.js';
import { openRelaySubscription } from '../../common/relay-socket.js';
import { parseProfileContent, type UserSearchResult } from './user-ranking.js';

const TIMEOUT_MS: number = 8000;

/**
 * Every profile the relays match to `query`, unranked, without muted people.
 *
 * Resolves once every relay has answered or the timeout expires, whichever
 * comes first. A relay that never answers costs the timeout and nothing else.
 * When `isWanted` turns false - the page was left - the search stops at the
 * next message rather than running on to the end.
 */
export function fetchUserSearchHits(
  query: string,
  relays: readonly string[],
  limit: number,
  isWanted: () => boolean = (): boolean => true,
): Promise<UserSearchResult[]> {
  return new Promise<UserSearchResult[]>((resolve) => {
    if (!query || relays.length === 0) {
      resolve([]);
      return;
    }
    // Keyed by pubkey: a person has one profile, and two relays holding
    // different revisions of it must not become two rows.
    const byPubkey: Map<PubkeyHex, UserSearchResult> = new Map();
    const stops: Array<() => void> = [];
    let answered: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearRelayTimeout(timer);
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Already gone.
        }
      }
      resolve(Array.from(byPubkey.values()));
    };
    const timer = setRelayTimeout(finish, TIMEOUT_MS);

    for (const relayUrl of relays) {
      let done: boolean = false;
      const oneDone = (): void => {
        if (done) return;
        done = true;
        answered += 1;
        if (answered >= relays.length) finish();
      };
      openRelaySubscription(
        relayUrl,
        { kinds: [0], search: query, limit },
        {
          onEvent: (event: NostrEvent): void => {
            if (!isWanted()) {
              finish();
              return;
            }
            const pubkey: PubkeyHex = event.pubkey as PubkeyHex;
            if (isMuted(pubkey)) return;
            const existing: UserSearchResult | undefined = byPubkey.get(pubkey);
            if (existing && existing.createdAt >= event.created_at) return;
            const profile: NostrProfile | null = parseProfileContent(
              event.content,
            );
            if (!profile) return;
            byPubkey.set(pubkey, {
              pubkey,
              npub: nip19.npubEncode(pubkey),
              profile,
              createdAt: event.created_at,
            });
          },
          onEose: oneDone,
          onClosed: oneDone,
        },
      )
        .then((stop: () => void): void => {
          // A relay that connected after the search ended is let go at once.
          if (settled) stop();
          else stops.push(stop);
        })
        .catch(oneDone);
    }
  });
}

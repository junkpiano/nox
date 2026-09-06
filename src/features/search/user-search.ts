import { avatarErrorAttribute } from '../../common/avatar.js';
/**
 * Finding a person, rather than a post.
 *
 * A NIP-50 relay answers `{kinds:[0], search}` with profiles ordered by how
 * recently their owner last edited them. That is not the order anyone looking
 * for a person wants: searching "jack" returns airport bots, Bluesky bridges
 * and a wall of identically-named strangers, while the well-known Jack is
 * absent because he has not touched his profile in months.
 *
 * So the relay's order is treated as raw material and the list is re-sorted
 * against signals we already hold - who the viewer follows, whether the name
 * actually matches, whether the profile claims a NIP-05 at all. None of them
 * costs a request. Follower counts would rank better, but counting followers
 * needs an indexer, and this app has no backend to run one.
 */

import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../../types/nostr';
import { isMuted } from '../../common/mute-state.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getAvatarURL, shortenNpub } from '../../utils/utils.js';
import {
  getCachedProfile,
  setCachedProfile,
} from '../profile/profile-cache.js';
import {
  MAX_ABOUT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NIP05_LENGTH,
  oneLine,
  parseProfileContent,
  rankUserResults,
  type UserSearchResult,
} from './user-ranking.js';

// Re-exported so every existing importer of this module keeps working.
export {
  decodePubkeyQuery,
  rankUserResults,
  type UserSearchResult,
} from './user-ranking.js';

export interface UserSearchParams {
  query: string;
  relays: string[];
  limit: number;
  followed: ReadonlySet<PubkeyHex>;
  timeoutMs?: number;
  activeWebSockets?: WebSocket[];
  isRouteActive?: () => boolean;
}

const USER_SEARCH_TIMEOUT_MS: number = 8000;


function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Collects kind 0 events matching `query` from every search relay.
 *
 * Resolves once every relay has sent EOSE or the timeout expires, whichever
 * comes first. A relay that never answers costs the timeout and nothing else.
 */
export function searchUsers(
  params: UserSearchParams,
): Promise<UserSearchResult[]> {
  const {
    query,
    relays,
    limit,
    followed,
    timeoutMs = USER_SEARCH_TIMEOUT_MS,
    activeWebSockets = [],
    isRouteActive = (): boolean => true,
  } = params;

  return new Promise<UserSearchResult[]>((resolve) => {
    if (!query || relays.length === 0) {
      resolve([]);
      return;
    }

    // Keyed by pubkey: a person has one profile, and two relays holding
    // different revisions of it must not become two rows.
    const byPubkey: Map<PubkeyHex, UserSearchResult> = new Map();
    let completedRelays: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(rankUserResults(Array.from(byPubkey.values()), query, followed));
    };

    const timeoutId: number = window.setTimeout(finish, timeoutMs);

    const completeRelay = (): void => {
      completedRelays += 1;
      if (completedRelays >= relays.length) {
        finish();
      }
    };

    relays.forEach((relayUrl: string): void => {
      let relayDone: boolean = false;
      const done = (): void => {
        if (relayDone) {
          return;
        }
        relayDone = true;
        completeRelay();
      };

      let socket: WebSocket;
      try {
        socket = createRelayWebSocket(relayUrl, true);
      } catch (error: unknown) {
        console.warn(`[UserSearch] Cannot open ${relayUrl}:`, error);
        done();
        return;
      }
      activeWebSockets.push(socket);
      const subId: string = `usearch-${Math.random().toString(36).slice(2)}`;

      socket.onopen = (): void => {
        socket.send(
          JSON.stringify(['REQ', subId, { kinds: [0], search: query, limit }]),
        );
      };

      socket.onmessage = (msg: MessageEvent): void => {
        if (!isRouteActive()) {
          socket.close();
          return;
        }
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const event: NostrEvent = data[2];
            if (!event || event.kind !== 0 || !event.pubkey) {
              return;
            }
            const pubkey: PubkeyHex = event.pubkey as PubkeyHex;
            if (isMuted(pubkey)) {
              return;
            }
            const existing: UserSearchResult | undefined = byPubkey.get(pubkey);
            if (existing && existing.createdAt >= event.created_at) {
              return;
            }
            const profile: NostrProfile | null = parseProfileContent(
              event.content,
            );
            if (!profile) {
              return;
            }
            byPubkey.set(pubkey, {
              pubkey,
              npub: nip19.npubEncode(pubkey),
              profile,
              createdAt: event.created_at,
            });
            return;
          }
          if (data[0] === 'EOSE' && data[1] === subId) {
            socket.close();
            done();
          }
        } catch (error: unknown) {
          console.warn(`[UserSearch] Bad message from ${relayUrl}:`, error);
        }
      };

      socket.onerror = (): void => {
        socket.close();
        done();
      };
      socket.onclose = (): void => {
        done();
      };
    });
  });
}

/**
 * Reconciles a search hit against the cache.
 *
 * A search relay's copy of a profile may be older than the one already stored,
 * and the cache is the authoritative render source. So a cached profile wins
 * and is returned unchanged; a pubkey with no cache entry is filled in from
 * the search result, which populates a gap without overwriting anything.
 */
export function reconcileWithCache(result: UserSearchResult): NostrProfile {
  const cached: NostrProfile | null = getCachedProfile(result.pubkey);
  if (cached) {
    return cached;
  }
  setCachedProfile(result.pubkey, result.profile);
  return result.profile;
}

function renderUserRow(result: UserSearchResult): string {
  const profile: NostrProfile = reconcileWithCache(result);
  const name: string =
    oneLine(profile.display_name, MAX_NAME_LENGTH) ||
    oneLine(profile.name, MAX_NAME_LENGTH) ||
    shortenNpub(result.npub);
  const nip05: string = oneLine(profile.nip05, MAX_NIP05_LENGTH);
  const about: string = oneLine(profile.about, MAX_ABOUT_LENGTH);
  // The picture URL is whatever its owner put in their profile, so it is
  // reduced to a scheme an <img> may be pointed at before it becomes a src.
  const avatar: string = getAvatarURL(result.pubkey, profile);
  const safeNpub: string = escapeHtml(result.npub);
  const safePubkey: string = escapeHtml(result.pubkey);

  return `
    <a href="/${safeNpub}" class="user-result flex items-start gap-3 py-3 rounded-lg hover:bg-gray-100 transition-colors" data-pubkey="${safePubkey}">
      <img src="${escapeHtml(avatar)}" alt="" class="w-10 h-10 rounded-full object-cover flex-shrink-0"
           onerror="${avatarErrorAttribute(result.pubkey)}" />
      <div class="min-w-0 flex-1">
        <div class="font-semibold text-gray-800 text-sm truncate">${escapeHtml(name)}</div>
        <div class="text-xs text-gray-500 truncate">${escapeHtml(nip05 || shortenNpub(result.npub))}</div>
        ${about ? `<div class="text-xs text-gray-600 mt-0.5 truncate">${escapeHtml(about)}</div>` : ''}
      </div>
    </a>
  `;
}

/**
 * Draws the People block above the post results, or nothing when empty.
 *
 * An empty block is worse than no block: it takes a line of the page to say
 * that a thing the reader did not ask about was not found.
 */
export function renderUserResults(
  container: HTMLElement,
  results: UserSearchResult[],
): void {
  if (results.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  container.innerHTML = `
    <h3 class="font-semibold text-sm text-gray-800 mb-2">People (${results.length})</h3>
    <div class="space-y-1 mb-6">
      ${results.map(renderUserRow).join('')}
    </div>
  `;
}

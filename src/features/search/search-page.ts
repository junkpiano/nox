import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../../types/nostr';
import { getProfile as getCachedDbProfile } from '../../common/db/index.js';
import { createDeletionGate } from '../../common/deletion-gate.js';
import { renderEvent } from '../../common/event-render.js';
import { fetchFollowList } from '../../common/events-queries.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { fetchingProfiles, profileCache } from '../../common/timeline-cache.js';
import { getAvatarURL, getDisplayName } from '../../utils/utils.js';
import {
  fetchProfile,
  getAuthoritativeProfile,
  getStoredPubkey,
} from '../profile/profile.js';
import { getCachedProfile as getPersistentCachedProfile } from '../profile/profile-cache.js';
import { getRelays } from '../relays/relays.js';
import {
  decodePubkeyQuery,
  rankUserResults,
  renderUserResults,
  searchUsers,
  type UserSearchResult,
} from './user-search.js';

export interface SearchPageOptions {
  query: string;
  relays: string[];
  limit: number;
  output: HTMLElement | null;
  connectingMsg: HTMLElement | null;
  activeWebSockets?: WebSocket[];
  activeTimeouts?: number[];
  isRouteActive?: () => boolean;
}

const SEARCH_TIMEOUT_MS: number = 12000;

function updateSearchInputs(query: string): void {
  const searchInput: HTMLInputElement | null = document.getElementById(
    'search-input',
  ) as HTMLInputElement | null;
  const searchInputMobile: HTMLInputElement | null = document.getElementById(
    'search-input-mobile',
  ) as HTMLInputElement | null;
  const clearSearchButton: HTMLElement | null = document.getElementById(
    'clear-search-button',
  );
  const clearSearchButtonMobile: HTMLElement | null = document.getElementById(
    'clear-search-button-mobile',
  );
  if (searchInput) {
    searchInput.value = query;
  }
  if (searchInputMobile) {
    searchInputMobile.value = query;
  }
  const shouldShowClear: boolean = query.length > 0;
  if (clearSearchButton) {
    clearSearchButton.style.display = shouldShowClear ? '' : 'none';
  }
  if (clearSearchButtonMobile) {
    clearSearchButtonMobile.style.display = shouldShowClear ? '' : 'none';
  }
}

function updateSearchHeader(query: string, count: number): void {
  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    if (!query) {
      postsHeader.textContent = 'Search';
    } else {
      const suffix: string = count > 0 ? ` (${count})` : '';
      postsHeader.textContent = `Search Results: "${query}"${suffix}`;
    }
    postsHeader.style.display = '';
  }
}

function showSearchMessage(output: HTMLElement, message: string): void {
  output.innerHTML = `
    <div class="text-center py-8">
      <p class="text-gray-700">${message}</p>
    </div>
  `;
}

function updateRenderedProfile(
  output: HTMLElement,
  pubkey: PubkeyHex,
  profile: NostrProfile | null,
): void {
  const renderProfile: NostrProfile | null = getAuthoritativeProfile(
    pubkey,
    profile,
  );
  const eventElements: NodeListOf<Element> =
    output.querySelectorAll('.event-container');
  eventElements.forEach((el: Element): void => {
    if ((el as HTMLElement).dataset.pubkey !== pubkey) {
      return;
    }
    const nameEl: Element | null = el.querySelector('.event-username');
    const avatarEl: Element | null = el.querySelector('.event-avatar');
    if (renderProfile) {
      if (nameEl) {
        const npubStr: Npub = nip19.npubEncode(pubkey);
        nameEl.textContent = `👤 ${getDisplayName(npubStr, renderProfile)}`;
      }
      if (avatarEl) {
        (avatarEl as HTMLImageElement).src = getAvatarURL(
          pubkey,
          renderProfile,
        );
      }
    }
  });
}

/**
 * How many profiles to ask each relay for.
 *
 * Deliberately far more than are shown: the relay orders by edit recency, so a
 * narrow ask returns a narrow slice of "recently edited" and the ranking has
 * nothing better to promote out of it.
 */
const USER_SEARCH_LIMIT: number = 100;

/** How many survive the ranking and reach the page, above the posts. */
const USER_RESULTS_SHOWN: number = 8;

interface UserResultsParams {
  query: string;
  relays: string[];
  container: HTMLElement;
  activeWebSockets: WebSocket[];
  routeIsActive: () => boolean;
}

/**
 * The viewer's follows, or an empty set when signed out or unreachable.
 *
 * Ranking degrades rather than fails without it: everyone simply falls through
 * to the name and NIP-05 tiers.
 */
async function loadFollowedSet(): Promise<Set<PubkeyHex>> {
  const storedPubkey: PubkeyHex | null = getStoredPubkey();
  if (!storedPubkey) {
    return new Set<PubkeyHex>();
  }
  try {
    const followed: PubkeyHex[] = await fetchFollowList(
      storedPubkey,
      getRelays(),
    );
    return new Set<PubkeyHex>(followed);
  } catch (error: unknown) {
    console.warn('[Search] Follow list unavailable; ranking without it', error);
    return new Set<PubkeyHex>();
  }
}

/**
 * Fills the People block, from a pasted key or from a name.
 *
 * Runs alongside the post search rather than before it, and renders into its
 * own container, so a slow or empty people search never holds up the posts.
 */
async function loadUserResults(params: UserResultsParams): Promise<void> {
  const { query, relays, container, activeWebSockets, routeIsActive } = params;

  const pastedPubkey: PubkeyHex | null = decodePubkeyQuery(query);
  if (pastedPubkey) {
    // A key names one person exactly. There is nothing here for a search relay
    // to match as text, so the profile comes from the viewer's own relays -
    // and from the cache first, which is where fetchProfile looks.
    try {
      const profile: NostrProfile | null = await fetchProfile(
        pastedPubkey,
        getRelays(),
      );
      if (!routeIsActive()) {
        return;
      }
      renderUserResults(container, [
        {
          pubkey: pastedPubkey,
          npub: nip19.npubEncode(pastedPubkey),
          // A key with no metadata anywhere is still a real person to open;
          // the row falls back to a shortened npub.
          profile: profile ?? {},
          createdAt: 0,
        },
      ]);
    } catch (error: unknown) {
      console.warn('[Search] Could not resolve the pasted key', error);
    }
    return;
  }

  // The follow list is fetched alongside the search, not before it: ranking
  // wants it, but a slow kind 3 must not delay the query.
  const [results, followed]: [UserSearchResult[], Set<PubkeyHex>] =
    await Promise.all([
      searchUsers({
        query,
        relays,
        limit: USER_SEARCH_LIMIT,
        followed: new Set<PubkeyHex>(),
        activeWebSockets,
        isRouteActive: routeIsActive,
      }),
      loadFollowedSet(),
    ]);

  if (!routeIsActive()) {
    return;
  }

  renderUserResults(
    container,
    rankUserResults(results, query, followed).slice(0, USER_RESULTS_SHOWN),
  );
}

export async function loadSearchPage(
  options: SearchPageOptions,
): Promise<void> {
  const {
    query,
    relays,
    limit,
    output,
    connectingMsg,
    activeWebSockets = [],
    activeTimeouts = [],
    isRouteActive,
  } = options;

  if (!output) {
    return;
  }

  const routeIsActive: () => boolean = isRouteActive || (() => true);
  updateSearchInputs(query);
  updateSearchHeader(query, 0);

  if (!query) {
    showSearchMessage(output, 'Enter a search query to begin.');
    if (connectingMsg) {
      connectingMsg.style.display = 'none';
    }
    return;
  }

  // Two blocks, so that "no posts found" cannot erase the people above it.
  output.innerHTML = `
    <div id="search-users" style="display: none;"></div>
    <div id="search-posts" class="space-y-4"></div>
  `;
  const usersContainer: HTMLElement = output.querySelector(
    '#search-users',
  ) as HTMLElement;
  const postsContainer: HTMLElement = output.querySelector(
    '#search-posts',
  ) as HTMLElement;

  if (connectingMsg) {
    connectingMsg.style.display = '';
  }

  if (relays.length === 0) {
    showSearchMessage(output, 'No search relays configured.');
    if (connectingMsg) {
      connectingMsg.style.display = 'none';
    }
    return;
  }

  void loadUserResults({
    query,
    relays,
    container: usersContainer,
    activeWebSockets,
    routeIsActive,
  });

  // A pasted key is not a phrase. Handing it to the post search as text gets
  // it ignored as an unmatched term, and the relay answers with a hundred
  // arbitrary recent posts under a header claiming they are results for that
  // key. The person it names is the answer; there is nothing else to look for.
  if (decodePubkeyQuery(query)) {
    if (connectingMsg) {
      connectingMsg.style.display = 'none';
    }
    updateSearchHeader(query, 0);
    return;
  }

  const seenEventIds: Set<string> = new Set();
  let renderedCount: number = 0;
  let completedRelays: number = 0;
  const totalRelays: number = relays.length;

  const finishSearch = (): void => {
    // What is still waiting at the gate is checked and drawn first.
    void gate.settle().then((): void => {
      if (!routeIsActive()) {
        return;
      }
      if (connectingMsg) {
        connectingMsg.style.display = 'none';
      }
      updateSearchHeader(query, renderedCount);
      if (renderedCount === 0) {
        showSearchMessage(postsContainer, 'No posts found.');
      }
    });
  };

  /** Draws one result that survived the gate. */
  const renderResult = (event: NostrEvent): void => {
    if (!routeIsActive()) {
      return;
    }
    renderedCount += 1;

    if (connectingMsg) {
      connectingMsg.style.display = 'none';
    }

    let profile: NostrProfile | null = profileCache.get(event.pubkey) || null;
    if (!profileCache.has(event.pubkey)) {
      const persistentProfile: NostrProfile | null = getPersistentCachedProfile(
        event.pubkey as PubkeyHex,
      );
      if (persistentProfile) {
        profile = persistentProfile;
        profileCache.set(event.pubkey, persistentProfile);
      } else {
        void getCachedDbProfile(event.pubkey as PubkeyHex).then(
          (cached: NostrProfile | null): void => {
            if (!routeIsActive() || !cached) return;
            profileCache.set(event.pubkey, cached);
            updateRenderedProfile(output, event.pubkey as PubkeyHex, cached);
          },
        );
      }
    }

    if (!fetchingProfiles.has(event.pubkey)) {
      fetchingProfiles.add(event.pubkey);
      fetchProfile(event.pubkey, relays, {
        usePersistentCache: false,
        persistProfile: true,
        forceRefresh: true,
      })
        .then((fetchedProfile: NostrProfile | null): void => {
          if (!routeIsActive()) return;
          fetchingProfiles.delete(event.pubkey);
          if (!fetchedProfile) {
            return;
          }
          profileCache.set(event.pubkey, fetchedProfile);
          updateRenderedProfile(
            output,
            event.pubkey as PubkeyHex,
            fetchedProfile,
          );
        })
        .catch((error: unknown): void => {
          console.error(
            `[Search] Failed to fetch profile for ${event.pubkey}`,
            error,
          );
          fetchingProfiles.delete(event.pubkey);
        });
    }

    const npubStr: Npub = nip19.npubEncode(event.pubkey);
    renderEvent(event, profile, npubStr, event.pubkey, postsContainer);
    updateSearchHeader(query, renderedCount);
  };

  // Results are held briefly, asked about together, and drawn only if
  // their authors did not withdraw them - the same gate the timelines use.
  const gate = createDeletionGate<NostrEvent>({
    relays,
    delayMs: 150,
    render: (events: NostrEvent[]): void => {
      for (const event of events) renderResult(event);
    },
  });

  const timeoutId: number = window.setTimeout((): void => {
    finishSearch();
  }, SEARCH_TIMEOUT_MS);
  activeTimeouts.push(timeoutId);

  const filter: Record<string, unknown> = {
    kinds: [1],
    search: query,
    limit,
  };

  relays.forEach((relayUrl: string): void => {
    if (!routeIsActive()) {
      return;
    }

    const socket: WebSocket = createRelayWebSocket(relayUrl, true);
    activeWebSockets.push(socket);
    const subId: string = `search-${Math.random().toString(36).slice(2)}`;
    let relayDone: boolean = false;

    const completeRelay = (): void => {
      if (relayDone) {
        return;
      }
      relayDone = true;
      completedRelays += 1;
      if (completedRelays >= totalRelays) {
        window.clearTimeout(timeoutId);
        finishSearch();
      }
    };

    socket.onopen = (): void => {
      const req = ['REQ', subId, filter];
      socket.send(JSON.stringify(req));
    };

    socket.onmessage = (msg: MessageEvent): void => {
      if (!routeIsActive()) {
        socket.close();
        return;
      }

      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event: NostrEvent = data[2];
          if (!event || !event.id || seenEventIds.has(event.id)) {
            return;
          }
          seenEventIds.add(event.id);
          gate.offer(event);
          return;
        }

        if (data[0] === 'EOSE' && data[1] === subId) {
          socket.close();
          completeRelay();
        }
      } catch (error: unknown) {
        console.warn(
          `[Search] Failed to parse message from ${relayUrl}:`,
          error,
        );
      }
    };

    socket.onerror = (): void => {
      socket.close();
      completeRelay();
    };

    socket.onclose = (): void => {
      completeRelay();
    };
  });
}

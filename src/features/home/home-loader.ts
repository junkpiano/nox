import type { PubkeyHex } from '../../../types/nostr';
import { emitAppEvent } from '../../common/app-events.js';
import {
  fetchFollowList,
  rememberedFollows,
} from '../../common/events-queries.js';
import { refreshFollowedHashtags } from '../../common/interests.js';
import { isReadOnlySession } from '../../common/session.js';
import { loadHomeTimeline } from './home-timeline.js';

interface LoadUserHomeTimelineOptions {
  pubkeyHex: PubkeyHex;
  relays: string[];
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
  connectingMsg: HTMLElement | null;
  homeKinds: number[];
  limit: number;
  seenEventIds: Set<string>;
  activeWebSockets: WebSocket[];
  activeTimeouts: number[];
  setUntilTimestamp: (value: number) => void;
  setNewestEventTimestamp: (value: number) => void;
  setCachedHomeTimeline: (
    followedWithSelf: PubkeyHex[],
    seen: Set<string>,
  ) => void;
  startBackgroundFetch: (followedWithSelf: PubkeyHex[]) => void;
  isRouteActive?: () => boolean;
}

export async function loadUserHomeTimeline(
  options: LoadUserHomeTimelineOptions,
): Promise<void> {
  try {
    const isRouteActive: () => boolean = options.isRouteActive || (() => true);
    if (!isRouteActive()) {
      return;
    }
    if (options.output) {
      options.output.innerHTML = `
        <div class="text-center py-12">
          <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
          <p class="text-gray-700 font-semibold">Fetching your follow list...</p>
          <p class="text-gray-500 text-sm mt-2">This may take a few seconds</p>
        </div>
      `;
    }

    const postsHeader: HTMLElement | null =
      document.getElementById('posts-header');
    if (postsHeader) {
      postsHeader.textContent = 'Home Timeline';
      postsHeader.style.display = '';
    }

    if (options.profileSection) {
      options.profileSection.innerHTML = '';
      options.profileSection.className = '';
    }

    // The lists this device remembers start Home at once; the relays' are
    // asked for alongside, and Home reloads only if one turns out
    // different. Followed hashtags announce their own change.
    const remembered: PubkeyHex[] | null = rememberedFollows(options.pubkeyHex);
    const fetched: Promise<PubkeyHex[]> = fetchFollowList(
      options.pubkeyHex,
      options.relays,
    );
    const hashtags: Promise<string[]> = refreshFollowedHashtags(
      options.pubkeyHex,
      options.relays,
    ).catch((): string[] => []);
    let followedPubkeys: PubkeyHex[];
    if (remembered) {
      followedPubkeys = remembered;
      void fetched
        .then((): void => {
          const now: PubkeyHex[] | null = rememberedFollows(options.pubkeyHex);
          // Whatever page is showing: the in-memory list is dropped either
          // way, and only Home reloads.
          if (now && [...now].sort().join() !== [...remembered].sort().join()) {
            emitAppEvent('follows-updated');
          }
        })
        .catch((): void => {});
    } else {
      // Nothing remembered yet: the first Home waits for both.
      [followedPubkeys] = await Promise.all([fetched, hashtags]);
    }
    if (!isRouteActive()) {
      return;
    }
    const followedWithSelf: PubkeyHex[] = Array.from(
      new Set([...followedPubkeys, options.pubkeyHex]),
    );

    if (options.output) {
      options.output.innerHTML = `
        <div class="text-center py-12">
          <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
          <p class="text-gray-700 font-semibold">Loading posts from ${followedPubkeys.length} people...</p>
        </div>
      `;
    }

    if (options.output) {
      options.seenEventIds.clear();
      const now: number = Math.floor(Date.now() / 1000);
      options.setUntilTimestamp(now);
      options.setNewestEventTimestamp(now);
      await loadHomeTimeline(
        followedWithSelf,
        options.homeKinds,
        options.relays,
        options.limit,
        now,
        options.seenEventIds,
        options.output,
        options.connectingMsg,
        options.activeWebSockets,
        options.activeTimeouts,
        isRouteActive,
        options.pubkeyHex, // Pass user's pubkey for cache key
      );

      if (!isRouteActive()) {
        return;
      }
      options.setCachedHomeTimeline(followedWithSelf, options.seenEventIds);
      options.startBackgroundFetch(followedWithSelf);
    }
  } catch (error: unknown) {
    console.error('Error loading home timeline:', error);
    // Browsing as a key that follows nobody is not a broken extension.
    if (!isReadOnlySession()) {
      localStorage.removeItem('nostr_pubkey');
    }

    if (options.output) {
      options.output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-red-600 mb-4">Failed to load home timeline.</p>
          <p class="text-gray-600 text-sm mb-4">Please try connecting your extension again.</p>
        </div>
      `;
    }
    throw error;
  }
}

import { nip19 } from 'nostr-tools';
import type { NostrProfile, Npub, PubkeyHex } from '../../types/nostr';
import {
  deleteTimeline,
  getTimelineNewestTimestamp,
} from '../common/db/index.js';
import { setActiveNav } from '../common/navigation.js';
import { isNip05Identifier, resolveNip05 } from '../common/nip05.js';
import {
  clearSessionPrivateKey,
  setSessionPrivateKeyFromRaw,
  updateLogoutButton,
} from '../common/session.js';
import { loadReactionsPage } from '../features/reactions/reactions-page.js';
import {
  getAllRelays,
  normalizeRelayUrl,
  setRelays,
} from '../features/relays/relays.js';
import {
  appState,
  closeAllWebSockets,
  composeButton,
  connectingMsg,
  createRouteGuard,
  getRestoreTimelineCount,
  homeKinds,
  importRelaysFromNip65,
  limit,
  output,
  profileSection,
  publishRelaysToNip65,
  renderLoadingState,
  replaceAppHistoryPath,
  restoreScrollFromState,
  restoreTimelineFromCache,
  searchRelays,
  seenEventIds,
  syncRelays,
} from './app-state.js';

type RouteDependencies = {
  startBackgroundFetch: (followedPubkeys: PubkeyHex[]) => void;
};

let routeDependencies: RouteDependencies | null = null;

export function configureRouteDependencies(deps: RouteDependencies): void {
  routeDependencies = deps;
}

function getRouteDependencies(): RouteDependencies {
  if (!routeDependencies) {
    throw new Error('Route dependencies have not been configured.');
  }
  return routeDependencies;
}

async function getAboutPageModule(): Promise<
  typeof import('../features/about/about-page.js')
> {
  return import('../features/about/about-page.js');
}

async function getBroadcastModule(): Promise<
  typeof import('../features/broadcast/broadcast.js')
> {
  return import('../features/broadcast/broadcast.js');
}

async function getEventPageModule(): Promise<
  typeof import('../features/event/event-page.js')
> {
  return import('../features/event/event-page.js');
}

async function getGlobalTimelineModule(): Promise<
  typeof import('../features/global/global-timeline.js')
> {
  return import('../features/global/global-timeline.js');
}

async function getHomeLoaderModule(): Promise<
  typeof import('../features/home/home-loader.js')
> {
  return import('../features/home/home-loader.js');
}

async function getHomeTimelineModule(): Promise<
  typeof import('../features/home/home-timeline.js')
> {
  return import('../features/home/home-timeline.js');
}

async function getWelcomeModule(): Promise<
  typeof import('../features/home/welcome.js')
> {
  return import('../features/home/welcome.js');
}

async function getNotificationsModule(): Promise<
  typeof import('../features/notifications/notifications-page.js')
> {
  return import('../features/notifications/notifications-page.js');
}

async function getProfileFollowModule(): Promise<
  typeof import('../features/profile/follow-page.js')
> {
  return import('../features/profile/follow-page.js');
}

async function getProfilePageModule(): Promise<
  typeof import('../features/profile/profile-page.js')
> {
  return import('../features/profile/profile-page.js');
}

async function getProfileEventsModule(): Promise<
  typeof import('../features/profile/profile-events.js')
> {
  return import('../features/profile/profile-events.js');
}

async function getRelaysPageModule(): Promise<
  typeof import('../features/relays/relays-page.js')
> {
  return import('../features/relays/relays-page.js');
}

async function getSearchPageModule(): Promise<
  typeof import('../features/search/search-page.js')
> {
  return import('../features/search/search-page.js');
}

async function getSettingsPageModule(): Promise<
  typeof import('../features/settings/settings-page.js')
> {
  return import('../features/settings/settings-page.js');
}

// `location.pathname` keeps percent-encoded characters, so `/user%40domain.com`
// never matches the NIP-05 branch unless it is decoded first.
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function escapeHtml(text: string): string {
  const div: HTMLDivElement = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function stopBackgroundFetch(): void {
  if (appState.backgroundFetchInterval) {
    clearInterval(appState.backgroundFetchInterval);
    appState.backgroundFetchInterval = null;
  }
}

function clearNewPostsNotification(): void {
  const notification = document.getElementById('new-posts-notification');
  if (notification) {
    notification.remove();
  }
}

function resetNotificationsButtonState(): void {
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  if (notificationsButton) {
    notificationsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    notificationsButton.classList.add('text-gray-700');
  }
}

export function handleRoute(scrollRestoreState?: unknown): void {
  const isRouteActive: () => boolean = createRouteGuard();
  const url: URL = new URL(window.location.href);
  const path: string = url.pathname;
  const searchQuery: string = (url.searchParams.get('q') || '').trim();
  updateLogoutButton(composeButton);
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  if (notificationsButton) {
    notificationsButton.style.display = storedPubkey ? '' : 'none';
  }
  const reactionsButton: HTMLElement | null =
    document.getElementById('nav-reactions');
  if (reactionsButton) {
    reactionsButton.style.display = storedPubkey ? '' : 'none';
  }

  void (async (): Promise<void> => {
    if (path === '/' || path === '') {
      // Redirect to /home
      replaceAppHistoryPath('/home');
      await loadHomePage(isRouteActive);
    } else if (path === '/home') {
      await loadHomePage(isRouteActive, scrollRestoreState);
    } else if (path === '/global') {
      await loadGlobalPage(isRouteActive, scrollRestoreState);
    } else if (path === '/search') {
      closeAllWebSockets();
      stopBackgroundFetch();
      clearNewPostsNotification();

      const homeButton: HTMLElement | null =
        document.getElementById('nav-home');
      const globalButton: HTMLElement | null =
        document.getElementById('nav-global');
      const relaysButton: HTMLElement | null =
        document.getElementById('nav-relays');
      const profileLink: HTMLElement | null =
        document.getElementById('nav-profile');
      const settingsButton: HTMLElement | null =
        document.getElementById('nav-settings');
      setActiveNav(
        homeButton,
        globalButton,
        relaysButton,
        profileLink,
        settingsButton,
        null,
      );

      if (profileSection) {
        profileSection.innerHTML = '';
        profileSection.className = '';
      }

      if (output) {
        output.innerHTML = '';
      }

      const { loadSearchPage } = await getSearchPageModule();
      await loadSearchPage({
        query: searchQuery,
        relays: searchRelays,
        limit: 100,
        output,
        connectingMsg,
        activeWebSockets: appState.activeWebSockets,
        activeTimeouts: appState.activeTimeouts,
        isRouteActive,
      });
    } else if (path === '/notifications') {
      const homeButton: HTMLElement | null =
        document.getElementById('nav-home');
      const globalButton: HTMLElement | null =
        document.getElementById('nav-global');
      const relaysButton: HTMLElement | null =
        document.getElementById('nav-relays');
      const notificationsButton: HTMLElement | null =
        document.getElementById('nav-notifications');
      const profileLink: HTMLElement | null =
        document.getElementById('nav-profile');
      const settingsButton: HTMLElement | null =
        document.getElementById('nav-settings');
      setActiveNav(
        homeButton,
        globalButton,
        relaysButton,
        profileLink,
        settingsButton,
        null,
      );
      if (notificationsButton) {
        notificationsButton.classList.remove('text-gray-700');
        notificationsButton.classList.add('bg-indigo-100', 'text-indigo-700');
      }
      const { loadNotificationsPage } = await getNotificationsModule();
      await loadNotificationsPage({
        relays: appState.relays,
        limit: 50,
        isRouteActive,
      });
    } else if (path === '/reactions') {
      const homeButton: HTMLElement | null =
        document.getElementById('nav-home');
      const globalButton: HTMLElement | null =
        document.getElementById('nav-global');
      const relaysButton: HTMLElement | null =
        document.getElementById('nav-relays');
      const notificationsButton: HTMLElement | null =
        document.getElementById('nav-notifications');
      const reactionsButton: HTMLElement | null =
        document.getElementById('nav-reactions');
      const profileLink: HTMLElement | null =
        document.getElementById('nav-profile');
      const settingsButton: HTMLElement | null =
        document.getElementById('nav-settings');
      setActiveNav(
        homeButton,
        globalButton,
        relaysButton,
        profileLink,
        settingsButton,
        null,
      );
      if (notificationsButton) {
        notificationsButton.classList.remove(
          'bg-indigo-100',
          'text-indigo-700',
        );
        notificationsButton.classList.add('text-gray-700');
      }
      if (reactionsButton) {
        reactionsButton.classList.remove('text-gray-700');
        reactionsButton.classList.add('bg-indigo-100', 'text-indigo-700');
      }
      await Promise.resolve(
        loadReactionsPage({
          relays: appState.relays,
          limit: 100,
          isRouteActive,
        }),
      );
    } else if (path === '/relays') {
      const { loadRelaysPage } = await getRelaysPageModule();
      await loadRelaysPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        getRelays: (): string[] => getAllRelays(),
        setRelays: (list: string[]): void => {
          setRelays(list);
          syncRelays();
        },
        normalizeRelayUrl,
        onRelaysChanged: syncRelays,
        onBroadcastRequested: async (): Promise<void> => {
          const statusEl: HTMLElement | null =
            document.getElementById('broadcast-status');
          const setStatus = (
            message: string,
            type: 'info' | 'error' | 'success' = 'info',
          ): void => {
            if (!statusEl) return;
            statusEl.textContent = message;
            if (type === 'error') {
              statusEl.className = 'text-xs text-red-600';
            } else if (type === 'success') {
              statusEl.className = 'text-xs text-emerald-700';
            } else {
              statusEl.className = 'text-xs text-gray-600';
            }
          };

          try {
            const { broadcastRecentPosts } = await getBroadcastModule();
            setStatus('Preparing broadcast...');
            const result = await broadcastRecentPosts({
              relays: getAllRelays(),
              limit: 50,
              onProgress: ({ total, completed }): void => {
                setStatus(`Broadcasting ${completed}/${total} posts...`);
              },
            });
            setStatus(
              `Broadcasted ${result.completed} posts to ${result.relays} relays.`,
              'success',
            );

            const storedPubkey: string | null =
              localStorage.getItem('nostr_pubkey');
            if (storedPubkey) {
              await deleteTimeline('home', storedPubkey as PubkeyHex);
            }
            appState.cachedHomeTimeline = null;
          } catch (error: unknown) {
            const message: string =
              error instanceof Error ? error.message : 'Broadcast failed.';
            setStatus(message, 'error');
          }
        },
        onNip65ImportRequested: importRelaysFromNip65,
        onNip65PublishRequested: publishRelaysToNip65,
        profileSection,
        output,
      });
    } else if (path === '/settings') {
      const { loadSettingsPage } = await getSettingsPageModule();
      await loadSettingsPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
      });
    } else if (path === '/about') {
      resetNotificationsButtonState();
      const { loadAboutPage } = await getAboutPageModule();
      await loadAboutPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
      });
    } else {
      // Try to parse as npub profile
      const npub: string = decodePathSegment(path.replace('/', '')).trim();
      if (npub.startsWith('nevent') || npub.startsWith('note')) {
        const { loadEventPage } = await getEventPageModule();
        await loadEventPage({
          eventRef: npub,
          relays: appState.relays,
          output,
          profileSection,
          closeAllWebSockets,
          stopBackgroundFetch,
          clearNotification: clearNewPostsNotification,
          isRouteActive,
        });
      } else if (isNip05Identifier(npub)) {
        // NIP-05 identifier (e.g., user@domain.com)
        closeAllWebSockets();
        stopBackgroundFetch();
        clearNewPostsNotification();

        const homeButton: HTMLElement | null =
          document.getElementById('nav-home');
        const globalButton: HTMLElement | null =
          document.getElementById('nav-global');
        const relaysButton: HTMLElement | null =
          document.getElementById('nav-relays');
        const profileLink: HTMLElement | null =
          document.getElementById('nav-profile');
        const settingsButton: HTMLElement | null =
          document.getElementById('nav-settings');
        setActiveNav(
          homeButton,
          globalButton,
          relaysButton,
          profileLink,
          settingsButton,
          profileLink,
        );
        resetNotificationsButtonState();

        renderLoadingState('Resolving NIP-05 identifier...', escapeHtml(npub));

        const pubkeyHex: PubkeyHex | null = await resolveNip05(npub);
        if (!isRouteActive()) return;
        if (pubkeyHex) {
          const resolvedNpub: string = nip19.npubEncode(pubkeyHex);
          await startApp(resolvedNpub as Npub, isRouteActive);
        } else if (output) {
          output.innerHTML = `
          <div class="text-center py-8">
            <p class="text-red-600 mb-4">Could not resolve NIP-05 identifier.</p>
            <p class="text-gray-600 text-sm">"${escapeHtml(npub)}" could not be found. Check the identifier and try again.</p>
          </div>
        `;
        }
      } else if (npub.startsWith('npub')) {
        // Close any active WebSocket connections from previous timeline
        // Note: Potential race condition if navigation happens quickly, but mitigated by
        // isRouteActive() guards that prevent new subscriptions from continuing after route change
        closeAllWebSockets();

        // Stop background fetching when switching away from home timeline
        stopBackgroundFetch();

        // Remove new posts notification if exists
        clearNewPostsNotification();

        const homeButton: HTMLElement | null =
          document.getElementById('nav-home');
        const globalButton: HTMLElement | null =
          document.getElementById('nav-global');
        const relaysButton: HTMLElement | null =
          document.getElementById('nav-relays');
        const profileLink: HTMLElement | null =
          document.getElementById('nav-profile');
        const settingsButton: HTMLElement | null =
          document.getElementById('nav-settings');
        setActiveNav(
          homeButton,
          globalButton,
          relaysButton,
          profileLink,
          settingsButton,
          profileLink,
        );
        resetNotificationsButtonState();
        await startApp(npub as Npub, isRouteActive);
      } else {
        if (output) {
          output.innerHTML = "<p class='text-red-500'>Invalid URL format.</p>";
        }
      }
    }

    if (!isRouteActive()) {
      return;
    }
    if (scrollRestoreState !== undefined) {
      await restoreScrollFromState(scrollRestoreState);
    }
  })();
}

// Load home page
export async function loadHomePage(
  isRouteActive: () => boolean,
  historyState?: unknown,
): Promise<void> {
  if (!isRouteActive()) {
    return;
  }

  const { startBackgroundFetch } = getRouteDependencies();

  // Close any active WebSocket connections from previous timeline
  closeAllWebSockets();

  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');

  // Set active navigation
  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLElement | null =
    document.getElementById('nav-profile');
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    homeButton,
  );
  if (notificationsButton) {
    notificationsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    notificationsButton.classList.add('text-gray-700');
  }

  // Update logout button visibility
  updateLogoutButton(composeButton);

  if (storedPubkey) {
    // User is logged in, load their home timeline
    const postsHeader: HTMLElement | null =
      document.getElementById('posts-header');
    if (postsHeader) {
      if (!isRouteActive()) return; // Guard before DOM update
      postsHeader.textContent = 'Home Timeline';
      postsHeader.style.display = '';
    }

    // Clear profile section
    if (profileSection) {
      if (!isRouteActive()) return; // Guard before DOM update
      profileSection.innerHTML = '';
      profileSection.className = '';
    }

    // If this navigation came from browser back/forward, restore the same
    // cached events first so scroll restoration lands on the same content.
    const restoreCount: number = getRestoreTimelineCount(historyState, 'home');
    if (restoreCount > 0) {
      const restored = await restoreTimelineFromCache({
        type: 'home',
        userPubkey: storedPubkey as PubkeyHex,
        desiredCount: restoreCount,
        isRouteActive,
      });
      if (restored.restored && isRouteActive()) {
        appState.untilTimestamp =
          restored.oldestTimestamp || Math.floor(Date.now() / 1000);
        appState.newestEventTimestamp =
          restored.newestTimestamp || Math.floor(Date.now() / 1000);

        if (
          !appState.backgroundFetchInterval &&
          appState.cachedHomeTimeline?.followedPubkeys?.length
        ) {
          startBackgroundFetch(
            appState.cachedHomeTimeline.followedPubkeys as PubkeyHex[],
          );
        }
        return;
      }
    }

    // Check if we have a cached follow list
    if (
      appState.cachedHomeTimeline &&
      appState.cachedHomeTimeline.followedPubkeys.length > 0
    ) {
      // Use cached follow list, reload timeline
      console.log('Using cached follow list, reloading home timeline');

      if (!isRouteActive()) return; // Guard before DOM update
      renderLoadingState('Loading your timeline...');
      seenEventIds.clear();
      appState.untilTimestamp = Math.floor(Date.now() / 1000);
      appState.newestEventTimestamp = appState.untilTimestamp;

      if (output) {
        const { loadHomeTimeline } = await getHomeTimelineModule();
        await loadHomeTimeline(
          appState.cachedHomeTimeline.followedPubkeys,
          homeKinds,
          appState.relays,
          limit,
          appState.untilTimestamp,
          seenEventIds,
          output,
          connectingMsg,
          appState.activeWebSockets,
          appState.activeTimeouts,
          isRouteActive,
          storedPubkey as PubkeyHex,
        );
      }
      if (!isRouteActive()) {
        return;
      }

      // Align background "since" cursor to newest cached timeline event.
      try {
        const newest: number = await getTimelineNewestTimestamp(
          'home',
          storedPubkey as PubkeyHex,
        );
        if (Number.isFinite(newest) && newest > 0) {
          appState.newestEventTimestamp = newest;
        }
      } catch {
        // Best-effort only.
      }

      // Restart background fetching
      if (!appState.backgroundFetchInterval) {
        startBackgroundFetch(appState.cachedHomeTimeline.followedPubkeys);
      }
    } else {
      // No cache, load fresh timeline
      if (output) {
        output.innerHTML = '';
      }
      seenEventIds.clear();
      appState.untilTimestamp = Math.floor(Date.now() / 1000);
      const { loadUserHomeTimeline } = await getHomeLoaderModule();
      await loadUserHomeTimeline({
        pubkeyHex: storedPubkey as PubkeyHex,
        relays: appState.relays,
        output,
        profileSection,
        connectingMsg,
        homeKinds,
        limit,
        seenEventIds,
        activeWebSockets: appState.activeWebSockets,
        activeTimeouts: appState.activeTimeouts,
        setUntilTimestamp: (value: number): void => {
          appState.untilTimestamp = value;
        },
        setNewestEventTimestamp: (value: number): void => {
          appState.newestEventTimestamp = value;
        },
        setCachedHomeTimeline: (
          followedWithSelf: PubkeyHex[],
          seen: Set<string>,
        ): void => {
          appState.cachedHomeTimeline = {
            events: Array.from(seen),
            followedPubkeys: followedWithSelf,
            timestamp: Date.now(),
          };
        },
        startBackgroundFetch,
        isRouteActive,
      });
      if (!isRouteActive()) {
        return;
      }

      // Align background "since" cursor to newest cached timeline event.
      try {
        const newest: number = await getTimelineNewestTimestamp(
          'home',
          storedPubkey as PubkeyHex,
        );
        if (Number.isFinite(newest) && newest > 0) {
          appState.newestEventTimestamp = newest;
        }
      } catch {
        // Best-effort only.
      }
    }
  } else {
    // User not logged in, show welcome screen
    const { showInputForm } = await getWelcomeModule();
    showInputForm({
      output,
      profileSection,
      composeButton,
      updateLogoutButton,
      clearSessionPrivateKey,
      setSessionPrivateKeyFromRaw,
      handleRoute,
    });
  }
}

// Load global page
export async function loadGlobalPage(
  isRouteActive: () => boolean,
  historyState?: unknown,
): Promise<void> {
  if (!isRouteActive()) {
    return;
  }
  // Close any active WebSocket connections from previous timeline
  closeAllWebSockets();

  // Set active navigation
  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLElement | null =
    document.getElementById('nav-profile');
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    globalButton,
  );
  if (notificationsButton) {
    notificationsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    notificationsButton.classList.add('text-gray-700');
  }

  // Stop background fetching when switching away from home timeline
  stopBackgroundFetch();

  // Remove new posts notification if exists
  clearNewPostsNotification();

  // Clear output and load global timeline
  if (!isRouteActive()) return; // Guard before DOM update
  renderLoadingState('Loading global timeline...');

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    if (!isRouteActive()) return; // Guard before DOM update
    postsHeader.textContent = 'Global Timeline';
    postsHeader.style.display = '';
  }

  // Clear profile section
  if (profileSection) {
    if (!isRouteActive()) return; // Guard before DOM update
    profileSection.innerHTML = '';
    profileSection.className = '';
  }

  seenEventIds.clear();
  appState.untilTimestamp = Math.floor(Date.now() / 1000);
  const restoreCount: number = getRestoreTimelineCount(historyState, 'global');
  if (restoreCount > 0) {
    const restored = await restoreTimelineFromCache({
      type: 'global',
      desiredCount: restoreCount,
      isRouteActive,
    });
    if (restored.restored && isRouteActive()) {
      appState.untilTimestamp =
        restored.oldestTimestamp || Math.floor(Date.now() / 1000);
      return;
    }
  }

  if (output) {
    const { loadGlobalTimeline } = await getGlobalTimelineModule();
    await loadGlobalTimeline(
      appState.relays,
      limit,
      appState.untilTimestamp,
      seenEventIds,
      output,
      connectingMsg,
      appState.activeWebSockets,
      appState.activeTimeouts,
      isRouteActive,
    );
  }
}

async function startApp(
  npub: Npub,
  isRouteActive: () => boolean,
): Promise<void> {
  if (!isRouteActive()) {
    return;
  }

  renderLoadingState('Loading profile and posts...');
  console.log('[App] Starting profile load for', npub);

  let didTimeout: boolean = false;
  const isStillActive = (): boolean => isRouteActive() && !didTimeout;

  try {
    await Promise.race([
      startAppCore(npub, isStillActive),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          didTimeout = true;
          reject(new Error('Profile loading timed out'));
        }, 15000);
      }),
    ]);
  } catch (error) {
    console.error('[App] Profile loading failed:', error);
    if (!isRouteActive()) return;
    if (output) {
      const message: string =
        error instanceof Error ? error.message : 'Unknown error';
      output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-red-600 mb-4">Failed to load profile.</p>
          <p class="text-gray-600 text-sm">${message}</p>
          <button onclick="window.location.reload()" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">
            Retry
          </button>
        </div>
      `;
    }
  }
}

async function startAppCore(
  npub: Npub,
  isRouteActive: () => boolean,
): Promise<void> {
  if (!isRouteActive()) {
    return;
  }

  let pubkeyHex: PubkeyHex;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
      throw new Error('Invalid npub address');
    }
    pubkeyHex = decoded.data;
  } catch (e) {
    if (output) {
      output.innerHTML =
        "<p class='text-red-500'>Failed to decode npub address.</p>";
    }
    throw e;
  }

  try {
    const { fetchProfile } = await getProfilePageModule();
    appState.profile = await Promise.race([
      fetchProfile(pubkeyHex, appState.relays),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 10000);
      }),
    ]);
    if (!appState.profile) {
      console.warn('[App] Profile fetch timed out, continuing anyway');
    } else {
      console.log('[App] Profile fetched: success');
    }
  } catch (error) {
    console.error('[App] Profile fetch failed:', error);
    appState.profile = null;
  }

  if (!isRouteActive()) {
    return;
  }
  if (profileSection) {
    const [{ renderProfile, setupProfileEditor, setupProfileZapButton }, { publishEventToRelays }] =
      await Promise.all([getProfilePageModule(), getProfileFollowModule()]);
    if (!isRouteActive()) return; // Guard before DOM update
    renderProfile(pubkeyHex, npub, appState.profile, profileSection);
    setupProfileZapButton(pubkeyHex, npub, appState.profile, profileSection);
    setupProfileEditor(pubkeyHex, npub, appState.profile, profileSection, {
      getRelays: (): string[] => appState.relays,
      publishEvent: publishEventToRelays,
      onProfileUpdated: (profile: NostrProfile): void => {
        appState.profile = profile;
      },
    });
  }

  try {
    const { setupFollowToggle, publishEventToRelays } =
      await getProfileFollowModule();
    await setupFollowToggle(pubkeyHex, {
      getRelays: (): string[] => appState.relays,
      publishEvent: publishEventToRelays,
      onFollowListChanged: (): void => {
        appState.cachedHomeTimeline = null;
      },
    });
    console.log('[App] Follow toggle setup complete');
  } catch (error) {
    console.error('[App] Follow toggle setup failed:', error);
  }
  if (!isRouteActive()) {
    return;
  }

  // Reset timestamp and seen events to fetch latest posts
  seenEventIds.clear();
  appState.untilTimestamp = Math.floor(Date.now() / 1000);

  if (output) {
    try {
      const { loadEvents } = await getProfileEventsModule();
      console.log('[App] Events loading started');
      await loadEvents(
        pubkeyHex,
        appState.profile,
        appState.relays,
        limit,
        appState.untilTimestamp,
        seenEventIds,
        output,
        connectingMsg,
        isRouteActive,
      );
    } catch (error) {
      console.error('[App] Events loading failed:', error);
      if (!isRouteActive()) return;
      if (output?.innerHTML.includes('Loading')) {
        output.innerHTML = `
          <div class="text-center py-8">
            <p class="text-red-600 mb-4">Failed to load posts.</p>
            <p class="text-gray-600 text-sm">The profile loaded, but posts could not be fetched.</p>
          </div>
        `;
      }
    }
  }
  if (!isRouteActive()) {
    return;
  }

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    if (!isRouteActive()) return; // Guard before DOM update
    postsHeader.textContent = 'Posts';
    postsHeader.style.display = '';
  }
}

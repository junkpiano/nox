import { nip19 } from 'nostr-tools';
import type { NostrProfile, Npub, PubkeyHex } from '../../types/nostr';
import {
  deleteTimeline,
  getTimelineNewestTimestamp,
} from '../common/db/index.js';
import { setActiveNav } from '../common/navigation.js';
import { isNip05Identifier, resolveNip05 } from '../common/nip05.js';
import { hidesWallet } from '../common/platform.js';
import {
  clearSessionPrivateKey,
  isReadOnlySession,
  setSessionPrivateKeyFromRaw,
  updateLogoutButton,
} from '../common/session.js';
import { canWrite } from '../common/signer.js';
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
  pushAppHistoryPath,
  renderLoadingState,
  replaceAppHistoryPath,
  restoreScrollFromState,
  restoreTimelineFromCache,
  searchRelays,
  seenEventIds,
  syncRelays,
} from './app-state.js';
import { clearNewPosts, stopNewPostsPolling } from './new-posts-row.js';

type RouteDependencies = {
  startBackgroundFetch: (followedPubkeys: PubkeyHex[]) => void;
  startGlobalBackgroundFetch: () => void;
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

async function getLegalPageModule(): Promise<
  typeof import('../features/legal/legal-page.js')
> {
  return import('../features/legal/legal-page.js');
}

async function getMessagesPageModule(): Promise<
  typeof import('../features/messages/messages-page.js')
> {
  return import('../features/messages/messages-page.js');
}

async function getWalletPageModule(): Promise<
  typeof import('../features/wallet/wallet-page.js')
> {
  return import('../features/wallet/wallet-page.js');
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

async function getSignInGateModule(): Promise<
  typeof import('../features/auth/sign-in-gate.js')
> {
  return import('../features/auth/sign-in-gate.js');
}

/**
 * The sign-in page.
 *
 * The same form the home timeline used to fall back to, given a route of its
 * own so the gate has somewhere to send people and so signing in is a place a
 * visitor can be, not a state a page happens to be in.
 */
async function loadSignInPage(): Promise<void> {
  closeAllWebSockets();
  stopBackgroundFetch();
  clearNewPostsNotification();
  setActiveNav(null, null, null, null, null, null);

  const { showInputForm } = await getWelcomeModule();
  await showInputForm({
    output,
    profileSection,
    composeButton,
    updateLogoutButton,
    clearSessionPrivateKey,
    setSessionPrivateKeyFromRaw,
    handleRoute,
  });

  // The mobile header mirrors this heading, and the form hides it on the way
  // in - which left the placeholder "Posts:" naming the sign-in page. Named
  // after the fact, for the same reason the legal pages name themselves.
  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'Sign in';
    postsHeader.style.display = '';
  }
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
  stopNewPostsPolling();
}

function clearNewPostsNotification(): void {
  clearNewPosts();
}

function resetNotificationsButtonState(): void {
  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  if (notificationsButton) {
    notificationsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    notificationsButton.classList.add('text-gray-700');
  }
}

/**
 * The routes a signed-out visitor may read.
 *
 * The global timeline is the shop window, settings and about have to work
 * before there is an account to configure, and the legal documents are
 * required to be reachable by both app stores - a gate in front of a privacy
 * policy fails review. Everything else asks first.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/global',
  '/settings',
  '/about',
  '/privacy',
  '/terms',
  '/signin',
]);

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

export function handleRoute(scrollRestoreState?: unknown): void {
  const isRouteActive: () => boolean = createRouteGuard();
  const url: URL = new URL(window.location.href);
  const path: string = url.pathname;
  const searchQuery: string = (url.searchParams.get('q') || '').trim();
  updateLogoutButton(composeButton);
  // Every route change runs through here, including the one right after
  // signing in, which is the moment tabs that depend on a session need to
  // refresh. pushState alone would miss it.
  window.dispatchEvent(new CustomEvent('app-route-changed'));
  // The event page dresses differently: no panel around the post, no
  // heading above it. Everything else takes the class off again.
  document.body.classList.toggle(
    'route-event',
    /^\/(nevent1|note1)/.test(path),
  );
  if (output && !/^\/(nevent1|note1)/.test(path)) {
    delete output.dataset.threadIds;
  }
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');

  void (async (): Promise<void> => {
    if (!storedPubkey && !isPublicPath(path)) {
      // The root is where a visitor lands with no intent of their own, so it
      // asks rather than refusing something they never requested.
      if (path === '/' || path === '') {
        replaceAppHistoryPath('/signin');
      }
      const { showSignInGate } = await getSignInGateModule();
      if (path === '/' || path === '') {
        await loadSignInPage();
      } else {
        showSignInGate({
          closeAllWebSockets,
          stopBackgroundFetch,
          clearNotification: clearNewPostsNotification,
          setActiveNav,
          navigateTo: (target: string): void => {
            pushAppHistoryPath(target);
            handleRoute();
          },
          output,
          profileSection,
        });
      }
      return;
    }

    if (path === '/signin') {
      if (storedPubkey && !isReadOnlySession()) {
        // Nothing to sign in to. Read-only is the exception: signing in is
        // exactly how it stops being read-only.
        replaceAppHistoryPath('/home');
        await loadHomePage(isRouteActive);
        return;
      }
      await loadSignInPage();
      return;
    }

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
        getRelays: (): string[] => appState.relays,
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
      });
    } else if (path === '/messages') {
      resetNotificationsButtonState();
      const { loadMessagesPage } = await getMessagesPageModule();
      loadMessagesPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
        getRelays: (): string[] => appState.relays,
      });
    } else if (path === '/wallet' && hidesWallet()) {
      // Hiding the drawer entry is not the same as closing the door: this
      // route is reachable by typing it, by an old link, and by history.
      replaceAppHistoryPath('/home');
      await loadHomePage(isRouteActive);
    } else if (path === '/wallet') {
      resetNotificationsButtonState();
      const { loadWalletPage } = await getWalletPageModule();
      loadWalletPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
      });
    } else if (path === '/privacy' || path === '/terms') {
      resetNotificationsButtonState();
      const { loadLegalPage } = await getLegalPageModule();
      loadLegalPage({
        closeAllWebSockets,
        stopBackgroundFetch,
        clearNotification: clearNewPostsNotification,
        setActiveNav,
        profileSection,
        output,
        document: path === '/privacy' ? 'privacy' : 'terms',
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
    // Signing out mid-session can land here before the router has re-run.
    // Signing in is its own route now, so send them to it rather than
    // rendering a second copy of the form inside the home timeline.
    replaceAppHistoryPath('/signin');
    await loadSignInPage();
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
      getRouteDependencies().startGlobalBackgroundFetch();
      return;
    }
  }

  if (output) {
    // Started before the load rather than after it: the poll skips
    // until there is something on screen to be newer than.
    getRouteDependencies().startGlobalBackgroundFetch();
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
    const [
      { renderProfile, setupProfileEditor, setupProfileZapButton },
      { publishEventToRelays },
    ] = await Promise.all([getProfilePageModule(), getProfileFollowModule()]);
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

    // Attached without waiting for the status to arrive: the editor watches
    // the line and reapplies itself when the relays fill it in, so there is no
    // ordering here to get wrong.
    // Only for someone who can sign it. Browsing as your own key shows
    // your status like anyone else's, and offers no box to change it.
    if (canWrite()) {
      const { setupStatusEditor } = await import(
        '../features/profile/status-editor.js'
      );
      setupStatusEditor(pubkeyHex, profileSection, {
        getRelays: (): string[] => appState.relays,
        publishEvent: publishEventToRelays,
        onPublished: (): void => {
          handleRoute();
        },
      });
    }
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

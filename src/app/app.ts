import type { PubkeyHex } from '../../types/nostr';
import { setupComposeOverlay } from '../common/compose.js';
import { getTimelineNewestTimestamp } from '../common/db/index.js';
import { setupNavigation } from '../common/navigation.js';
import { setupImageOverlay } from '../common/overlays.js';
import { createRelayWebSocket } from '../common/relay-socket.js';
import { setupReplyOverlay } from '../common/reply.js';
import { setupSearchBar } from '../common/search.js';
import {
  clearSessionPrivateKey,
  getSessionPrivateKey,
  updateLogoutButton,
} from '../common/session.js';
import {
  registerServiceWorker,
  startPeriodicSync,
} from '../common/sync/service-worker-manager.js';
import { setupZapOverlay } from '../common/zap.js';
import { loadGlobalTimeline } from '../features/global/global-timeline.js';
import { loadUserHomeTimeline } from '../features/home/home-loader.js';
import { loadHomeTimeline } from '../features/home/home-timeline.js';
import { clearNotifications } from '../features/notifications/notifications.js';
import { publishEventToRelays } from '../features/profile/follow.js';
import { recordRelayFailure } from '../features/relays/relays.js';
import {
  configureRouteDependencies,
  handleRoute,
  loadGlobalPage,
  loadHomePage,
} from './app-routes.js';
import {
  appState,
  composeButton,
  connectingMsg,
  createRouteGuard,
  homeKinds,
  limit,
  maybeSyncRelaysFromNip65OnLogin,
  output,
  profileSection,
  pushAppHistoryPath,
  saveScrollToHistoryState,
  seenEventIds,
  syncRelays,
} from './app-state.js';

function showNewEventsNotification(_timelineType: string, count: number): void {
  // Remove existing notification if any
  const existingNotification = document.getElementById(
    'sw-new-events-notification',
  );
  if (existingNotification) {
    existingNotification.remove();
  }

  // Create notification banner
  const notification = document.createElement('div');
  notification.id = 'sw-new-events-notification';
  notification.className =
    'fixed top-16 left-1/2 transform -translate-x-1/2 z-50 bg-indigo-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-3 cursor-pointer hover:bg-indigo-700 transition-colors';
  notification.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
    </svg>
    <span>${count} new ${count === 1 ? 'post' : 'posts'} available</span>
    <button class="ml-2 text-sm underline">Refresh</button>
  `;

  notification.addEventListener('click', (): void => {
    // Force a relay refresh instead of going through handleRoute(), because
    // handleRoute() may restore from cache for back/forward navigations.
    void (async (): Promise<void> => {
      notification.remove();

      const path: string = window.location.pathname;
      if (path === '/home') {
        const storedPubkey: string | null =
          localStorage.getItem('nostr_pubkey');
        if (!storedPubkey || !output) {
          handleRoute();
          return;
        }

        // Prefer the cached follow list; fall back to refetching if missing.
        const followedPubkeys: PubkeyHex[] =
          (appState.cachedHomeTimeline?.followedPubkeys as
            | PubkeyHex[]
            | undefined) || [];

        output.innerHTML = '';
        seenEventIds.clear();
        appState.untilTimestamp = Math.floor(Date.now() / 1000);
        appState.newestEventTimestamp = appState.untilTimestamp;

        const routeGuard: () => boolean = createRouteGuard();
        if (followedPubkeys.length > 0) {
          await loadHomeTimeline(
            followedPubkeys,
            homeKinds,
            appState.relays,
            limit,
            appState.untilTimestamp,
            seenEventIds,
            output,
            connectingMsg,
            appState.activeWebSockets,
            appState.activeTimeouts,
            routeGuard,
            storedPubkey as PubkeyHex,
          );
        } else {
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
            isRouteActive: routeGuard,
          });
        }

        // Best-effort: align the background fetch cursor to the newest cached event.
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
        return;
      }

      if (path === '/global') {
        if (!output) {
          handleRoute();
          return;
        }

        output.innerHTML = '';
        seenEventIds.clear();
        appState.untilTimestamp = Math.floor(Date.now() / 1000);

        const routeGuard: () => boolean = createRouteGuard();
        await loadGlobalTimeline(
          appState.relays,
          limit,
          appState.untilTimestamp,
          seenEventIds,
          output,
          connectingMsg,
          appState.activeWebSockets,
          appState.activeTimeouts,
          routeGuard,
        );
        return;
      }

      // Fallback for other routes.
      handleRoute();
    })();
  });

  document.body.appendChild(notification);

  // Auto-hide after 10 seconds
  setTimeout((): void => {
    if (notification.parentElement) {
      notification.remove();
    }
  }, 10000);
}

function handleLogout(): void {
  localStorage.removeItem('nostr_pubkey');
  clearSessionPrivateKey();
  clearNotifications();

  appState.cachedHomeTimeline = null;

  if (appState.backgroundFetchInterval) {
    clearInterval(appState.backgroundFetchInterval);
    appState.backgroundFetchInterval = null;
  }

  const notification = document.getElementById('new-posts-notification');
  if (notification) {
    notification.remove();
  }

  updateLogoutButton(composeButton);
}

function startBackgroundFetch(followedPubkeys: PubkeyHex[]): void {
  // Clear existing interval if any
  if (appState.backgroundFetchInterval) {
    clearInterval(appState.backgroundFetchInterval);
  }

  // Fetch new posts every 30 seconds
  appState.backgroundFetchInterval = window.setInterval(async () => {
    await fetchNewPosts(followedPubkeys);
  }, 30000);

  // Start service worker periodic sync
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (storedPubkey) {
    startPeriodicSync({
      userPubkey: storedPubkey as PubkeyHex,
      followedPubkeys: followedPubkeys,
      syncGlobal: false, // Only sync home timeline for now
    }).catch((error: unknown): void => {
      console.error('[App] Failed to start periodic sync:', error);
    });
  }
}

async function fetchNewPosts(followedPubkeys: PubkeyHex[]): Promise<void> {
  if (!output || followedPubkeys.length === 0) return;

  const newEvents: any[] = [];
  // Nostr filter `since` is inclusive; +1 avoids repeatedly refetching the same newest timestamp.
  const since = appState.newestEventTimestamp + 1;

  for (const relayUrl of appState.relays) {
    try {
      const socket: WebSocket = createRelayWebSocket(relayUrl);

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          recordRelayFailure(relayUrl);
          socket.close();
          resolve();
        }, 5000);

        socket.onopen = (): void => {
          const subId: string = `new-${Math.random().toString(36).slice(2)}`;
          const req = [
            'REQ',
            subId,
            {
              kinds: homeKinds,
              authors: followedPubkeys,
              since: since,
              limit: 20,
            },
          ];
          socket.send(JSON.stringify(req));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'EVENT') {
            const event = arr[2];
            if (!seenEventIds.has(event.id)) {
              newEvents.push(event);
              if (event.created_at > appState.newestEventTimestamp) {
                appState.newestEventTimestamp = event.created_at;
              }
            }
          } else if (arr[0] === 'EOSE') {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        };

        socket.onerror = (): void => {
          clearTimeout(timeout);
          socket.close();
          resolve();
        };
      });
    } catch (e) {
      console.warn(`Failed to fetch new posts from ${relayUrl}:`, e);
    }
  }

  if (newEvents.length > 0) {
    showNewPostsNotification(newEvents.length);
  }
}

function showNewPostsNotification(count: number): void {
  // Check if notification already exists
  let notification: HTMLElement | null = document.getElementById(
    'new-posts-notification',
  );

  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'new-posts-notification';
    notification.className =
      'fixed top-20 left-1/2 transform -translate-x-1/2 bg-indigo-600 text-white px-6 py-3 rounded-lg shadow-lg cursor-pointer hover:bg-indigo-700 transition-colors z-50 animate-bounce';
    notification.innerHTML = `
      <span class="font-semibold">${count} new post${count > 1 ? 's' : ''} available</span>
      <span class="ml-2">↻ Click to refresh</span>
    `;

    notification.addEventListener('click', async () => {
      const storedPubkey = localStorage.getItem('nostr_pubkey');
      if (storedPubkey) {
        // Remove notification
        notification?.remove();
        // Reload timeline
        if (output) {
          output.innerHTML = '';
        }
        seenEventIds.clear();
        appState.untilTimestamp = Math.floor(Date.now() / 1000);
        appState.newestEventTimestamp = appState.untilTimestamp;

        const followedPubkeys =
          appState.cachedHomeTimeline?.followedPubkeys || [];
        if (followedPubkeys.length > 0 && output) {
          const isRouteActive = createRouteGuard();
          await loadHomeTimeline(
            followedPubkeys,
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
      }
    });

    document.body.appendChild(notification);
  } else {
    // Update existing notification
    notification.innerHTML = `
      <span class="font-semibold">${count} new post${count > 1 ? 's' : ''} available</span>
      <span class="ml-2">↻ Click to refresh</span>
    `;
  }
}

configureRouteDependencies({ startBackgroundFetch });

document.addEventListener('DOMContentLoaded', (): void => {
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }

  // Ensure the initial history entry has state we can mutate as the user scrolls.
  saveScrollToHistoryState();

  let scrollSyncTimer: number | null = null;
  window.addEventListener(
    'scroll',
    (): void => {
      if (scrollSyncTimer !== null) {
        return;
      }
      scrollSyncTimer = window.setTimeout((): void => {
        scrollSyncTimer = null;
        saveScrollToHistoryState();
      }, 150);
    },
    { passive: true },
  );

  window.addEventListener('relays-updated', syncRelays);
  if (connectingMsg) {
    connectingMsg.style.display = 'none'; // Hide connecting message by default
  }

  // Register service worker for background sync
  registerServiceWorker()
    .then((success: boolean): void => {
      if (success) {
        console.log('[App] Service worker registered successfully');
      }
    })
    .catch((error: unknown): void => {
      console.error('[App] Failed to register service worker:', error);
    });

  // Listen for new events from service worker
  window.addEventListener('sw-new-events', ((event: CustomEvent): void => {
    const { timelineType, count } = event.detail;
    console.log(
      `[App] Service worker found ${count} new events for ${timelineType} timeline`,
    );

    // Show notification banner
    showNewEventsNotification(timelineType, count);
  }) as EventListener);

  // Setup search functionality
  setupSearchBar((path: string): void => {
    saveScrollToHistoryState();
    pushAppHistoryPath(path);
    handleRoute();
  });

  // Setup navigation
  setupNavigation({
    navigateTo: (path: string): void => {
      saveScrollToHistoryState();
      pushAppHistoryPath(path);
      handleRoute();
    },
    onLogout: handleLogout,
  });

  // If the user hasn't customized relays yet, try to discover their NIP-65 relay list.
  void maybeSyncRelaysFromNip65OnLogin();

  // Setup image overlay
  setupImageOverlay();

  // Setup composer overlay
  setupComposeOverlay({
    composeButton,
    getSessionPrivateKey,
    getRelays: (): string[] => appState.relays,
    publishEvent: publishEventToRelays,
    refreshTimeline: async (): Promise<void> => {
      const isRouteActive: () => boolean = createRouteGuard();
      if (window.location.pathname === '/home') {
        await loadHomePage(isRouteActive);
      } else if (window.location.pathname === '/global') {
        await loadGlobalPage(isRouteActive);
      }
    },
  });

  // Setup reply overlay
  setupReplyOverlay({
    getSessionPrivateKey,
    getRelays: (): string[] => appState.relays,
    publishEvent: publishEventToRelays,
    refreshTimeline: async (): Promise<void> => {
      const isRouteActive: () => boolean = createRouteGuard();
      if (window.location.pathname === '/home') {
        await loadHomePage(isRouteActive);
      } else if (window.location.pathname === '/global') {
        await loadGlobalPage(isRouteActive);
      }
    },
  });

  setupZapOverlay({
    getSessionPrivateKey,
    getRelays: (): string[] => appState.relays,
  });

  document.addEventListener('click', (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target: HTMLElement | null = event.target as HTMLElement | null;
    const anchor: HTMLAnchorElement | null = target
      ? target.closest('a')
      : null;
    if (
      !anchor ||
      anchor.target === '_blank' ||
      anchor.hasAttribute('download')
    ) {
      return;
    }

    const href: string | null = anchor.getAttribute('href');
    if (!href || !href.startsWith('/')) {
      return;
    }

    const url: URL = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      return;
    }

    event.preventDefault();
    saveScrollToHistoryState();
    pushAppHistoryPath(url.pathname);
    handleRoute();
  });

  // Handle initial route
  handleRoute();
});

// Cleanup background fetch on page unload
window.addEventListener('beforeunload', (): void => {
  if (appState.backgroundFetchInterval) {
    clearInterval(appState.backgroundFetchInterval);
  }
});

// Handle browser back/forward buttons
window.addEventListener('popstate', (event: PopStateEvent): void => {
  handleRoute(event.state);
});

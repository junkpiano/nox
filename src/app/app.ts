import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { setupBottomTabs } from '../common/bottom-tabs.js';
import { setupComposeOverlay } from '../common/compose.js';
import { clearMuteList, loadCachedMuteList } from '../common/mute-state.js';
import { setupNavigation } from '../common/navigation.js';
import { setupImageOverlay } from '../common/overlays.js';
import { applyPlatformClass } from '../common/platform-class.js';
import { setupReplyOverlay } from '../common/reply.js';
import { setupSearchBar } from '../common/search.js';
import {
  clearSessionPrivateKey,
  getSessionPrivateKey,
  restoreSessionPrivateKey,
  updateLogoutButton,
} from '../common/session.js';
import {
  registerServiceWorker,
  startPeriodicSync,
} from '../common/sync/service-worker-manager.js';
import { hasAcceptedTerms } from '../common/terms.js';
import { setupZapOverlay } from '../common/zap.js';
import { showTermsGate } from '../features/legal/terms-gate.js';
import { clearMessages } from '../features/messages/messages-store.js';
import { stopMessageSync } from '../features/messages/messages-sync.js';
import { migrateLegacyMessageCache } from '../features/messages/plaintext-cache-migration.js';
import { refreshMuteListFromRelays } from '../features/moderation/moderation-actions.js';
import { setupModerationOverlay } from '../features/moderation/moderation-overlay.js';
import { clearNotifications } from '../features/notifications/notifications.js';
import {
  clearWalletConnection,
  loadWalletConnection,
} from '../features/wallet/wallet-store.js';
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
  maybeSyncRelaysFromNip65OnLogin,
  pushAppHistoryPath,
  replaceAppHistoryPath,
  saveScrollToHistoryState,
  syncRelays,
} from './app-state.js';
import {
  clearNewPosts,
  pollForNewPosts,
  startNewPostsPolling,
  stopNewPostsPolling,
} from './new-posts-row.js';

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

async function publishEventToRelays(
  event: NostrEvent,
  relayList: string[],
): Promise<void> {
  const { publishEventToRelays } = await import(
    '../features/profile/follow-page.js'
  );
  await publishEventToRelays(event, relayList);
}

function handleLogout(): void {
  localStorage.removeItem('nostr_pubkey');
  clearSessionPrivateKey();
  clearNotifications();
  // Otherwise the next account inherits this one's mute list.
  clearMuteList();
  // The connection secret can spend money. Leaving it behind would hand the
  // next person to sign in on this device a working wallet permission.
  void clearWalletConnection();
  // Decrypted message history must not outlive the account it belongs to.
  clearMessages();
  stopMessageSync();

  appState.cachedHomeTimeline = null;

  stopNewPostsPolling();
  clearNewPosts();

  updateLogoutButton(composeButton);
}

/**
 * Keeps the home timeline current without moving it.
 *
 * New posts wait behind a row at the top of the list; see new-posts-row.ts.
 * The service worker's periodic sync is started alongside, for when the
 * tab is in the background.
 */
function startBackgroundFetch(followedPubkeys: PubkeyHex[]): void {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  startNewPostsPolling({
    timelineType: 'home',
    ...(storedPubkey ? { timelinePubkey: storedPubkey as PubkeyHex } : {}),
    filter: { kinds: homeKinds, authors: followedPubkeys },
  });

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

/** The same for the global timeline, which had no way to learn of new posts. */
function startGlobalBackgroundFetch(): void {
  startNewPostsPolling({
    timelineType: 'global',
    filter: { kinds: [1, 6, 16] },
  });
}

configureRouteDependencies({
  startBackgroundFetch,
  startGlobalBackgroundFetch,
});

document.addEventListener('DOMContentLoaded', (): void => {
  // Before anything renders, so the safe-area rules apply to the first paint.
  applyPlatformClass();

  // Nothing else starts until this resolves. The global timeline has no
  // filter, so an app that boots first and asks afterwards has already shown a
  // stranger's post to somebody who was never told what this is.
  void showTermsGate().then(boot);
});

function boot(): void {
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

  setupModerationOverlay({
    getRelays: (): string[] => appState.relays,
  });

  // Muting hides an author mid-session, so re-run the route to drop their
  // cards from whatever is on screen.
  window.addEventListener('mute-list-updated', (): void => {
    handleRoute();
  });
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

    // Whatever it found goes behind the new-posts row like anything else,
    // so there is one way of being told and not a second banner.
    void pollForNewPosts();
  }) as EventListener);

  // Setup search functionality
  setupSearchBar((path: string): void => {
    saveScrollToHistoryState();
    pushAppHistoryPath(path);
    handleRoute();
  });

  setupBottomTabs();

  // Lets a deeply nested view request navigation without being handed the
  // router; the profile page uses this to open a conversation.
  window.addEventListener('navigate-to-path', ((event: CustomEvent): void => {
    const path: unknown = event.detail?.path;
    if (typeof path !== 'string') {
      return;
    }
    saveScrollToHistoryState();
    if (event.detail?.replace === true) {
      replaceAppHistoryPath(path);
    } else {
      pushAppHistoryPath(path);
    }
    handleRoute();
  }) as EventListener);

  // Loaded once so the zap flow can tell synchronously whether a wallet is
  // available, instead of reaching for the credential store mid-payment.
  void loadWalletConnection();

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

  // Handle initial route.
  // The key is restored first because routing kicks off the initial timeline
  // load, and NIP-42 AUTH during that load needs the key already in memory.
  //
  // The message cache migration runs ahead of both. It can rebuild the
  // database, and a read already in flight when that happens never returns.
  // For everyone past the upgrade it is a single metadata lookup.
  void migrateLegacyMessageCache()
    .catch((error: unknown): void => {
      console.warn('[dm] Message cache migration failed:', error);
    })
    .then(
      (): Promise<unknown> =>
        Promise.all([restoreSessionPrivateKey(), loadCachedMuteList()]),
    )
    .finally((): void => {
      updateLogoutButton(composeButton);
      handleRoute();
      // Refreshed in the background: the cached list already filters the first
      // render, and a relay round-trip should not delay it.
      void refreshMuteListFromRelays(appState.relays);
    });
}

// Cleanup background fetch on page unload
window.addEventListener('beforeunload', (): void => {
  if (appState.backgroundFetchInterval) {
    clearInterval(appState.backgroundFetchInterval);
  }
});

// Handle browser back/forward buttons
window.addEventListener('popstate', (event: PopStateEvent): void => {
  // Not while the gate is up. The overlay covers the page, but a route run
  // behind it would still open sockets and fetch posts - and "covered" is a
  // stylesheet away from "shown".
  if (!hasAcceptedTerms()) {
    return;
  }
  handleRoute(event.state);
});

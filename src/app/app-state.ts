import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../types/nostr';
import {
  getCachedTimeline,
  getProfile as getCachedDbProfile,
} from '../common/db/index.js';
import { renderEvent } from '../common/event-render.js';
import { getCachedProfile as getPersistentCachedProfile } from '../features/profile/profile-cache.js';
import { publishEventToRelays } from '../features/profile/follow.js';
import { getRelays, didUserConfigureRelays, setRelays } from '../features/relays/relays.js';
import {
  fetchNip65RelayList,
  signNip65RelayListEvent,
} from '../features/relays/nip65.js';

export const output: HTMLElement | null = document.getElementById('nostr-output');
export const profileSection: HTMLElement | null =
  document.getElementById('profile-section');
export const composeButton: HTMLElement | null =
  document.getElementById('nav-compose');
export const connectingMsg: HTMLElement | null =
  document.getElementById('connecting-msg');

export const searchRelays: string[] = [
  'wss://search.nos.today/',
  'wss://relay.nostr.band/',
];

// Fetch a solid chunk up-front; pagination ("Load more") is currently disabled for stability.
export const limit: number = 200;
export const homeKinds: number[] = [1, 2, 6, 9, 11, 16, 22, 28, 40, 70, 77];
export const seenEventIds: Set<string> = new Set();

export type AppHistoryState = {
  __nostrSpa?: true;
  scrollX?: number;
  scrollY?: number;
  timeline?: {
    type: 'home' | 'global';
    count: number;
  };
};

export type CachedHomeTimeline = {
  events: any[];
  followedPubkeys: string[];
  timestamp: number;
};

export type AppState = {
  relays: string[];
  untilTimestamp: number;
  profile: NostrProfile | null;
  cachedHomeTimeline: CachedHomeTimeline | null;
  backgroundFetchInterval: number | null;
  newestEventTimestamp: number;
  activeRouteToken: number;
  activeWebSockets: WebSocket[];
  activeTimeouts: number[];
};

export const appState: AppState = {
  relays: getRelays(),
  untilTimestamp: Math.floor(Date.now() / 1000),
  profile: null,
  cachedHomeTimeline: null,
  backgroundFetchInterval: null,
  newestEventTimestamp: Math.floor(Date.now() / 1000),
  activeRouteToken: 0,
  activeWebSockets: [],
  activeTimeouts: [],
};

export async function importRelaysFromNip65(): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    throw new Error('Sign-in required.');
  }

  const result = await fetchNip65RelayList({
    pubkeyHex: storedPubkey as PubkeyHex,
    relays: getRelays(),
  });

  if (!result || result.relayUrls.length === 0) {
    throw new Error('No NIP-65 relay list found.');
  }

  setRelays(result.relayUrls);
  syncRelays();
}

export async function publishRelaysToNip65(): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    throw new Error('Sign-in required.');
  }

  const relayUrls: string[] = getRelays();
  const event: NostrEvent = await signNip65RelayListEvent({
    pubkeyHex: storedPubkey as PubkeyHex,
    relayUrls,
  });
  await publishEventToRelays(event, relayUrls);
}

export async function maybeSyncRelaysFromNip65OnLogin(): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) return;

  // Don't surprise users who already customized relays in this browser.
  if (didUserConfigureRelays()) return;

  try {
    await importRelaysFromNip65();
  } catch (error: unknown) {
    // Best-effort only. Keep defaults if NIP-65 fetch fails or doesn't exist.
    console.log('[NIP-65] No relay list imported on login:', error);
  }
}

export function renderLoadingState(message: string, subMessage: string = ''): void {
  if (!output) {
    return;
  }

  output.innerHTML = `
    <div class="text-center py-12">
      <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
      <p class="text-gray-700 font-semibold">${message}</p>
      ${subMessage ? `<p class="text-gray-500 text-sm mt-2">${subMessage}</p>` : ''}
    </div>
  `;
}

// Close all active WebSocket connections and clear timeouts
export function closeAllWebSockets(): void {
  appState.activeWebSockets.forEach((socket: WebSocket): void => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  });
  appState.activeWebSockets = [];

  // Clear all active timeouts
  appState.activeTimeouts.forEach((timeoutId: number): void => {
    clearTimeout(timeoutId);
  });
  appState.activeTimeouts = [];
}

export function createRouteGuard(): () => boolean {
  appState.activeRouteToken += 1;
  const token: number = appState.activeRouteToken;
  return (): boolean => token === appState.activeRouteToken;
}

function getCurrentHistoryStateObject(): Record<string, unknown> {
  const state: unknown = window.history.state;
  if (state && typeof state === 'object') {
    return state as Record<string, unknown>;
  }
  return {};
}

function getCurrentTimelineHistoryHint():
  | AppHistoryState['timeline']
  | undefined {
  const path: string = window.location.pathname;
  if (path !== '/home' && path !== '/global') {
    return undefined;
  }
  const count: number = document.querySelectorAll('.event-container').length;
  if (count <= 0) {
    return undefined;
  }
  return {
    type: path === '/home' ? 'home' : 'global',
    count,
  };
}

export function saveScrollToHistoryState(): void {
  const base: Record<string, unknown> = getCurrentHistoryStateObject();
  const nextState: AppHistoryState & Record<string, unknown> = {
    ...base,
    __nostrSpa: true,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const timelineHint: AppHistoryState['timeline'] | undefined =
    getCurrentTimelineHistoryHint();
  if (timelineHint) {
    nextState.timeline = timelineHint;
  } else {
    // With exactOptionalPropertyTypes, explicitly writing `timeline: undefined`
    // is not the same as omitting the property.
    delete (nextState as any).timeline;
  }
  const url: string =
    window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState(nextState, '', url);
}

export function pushAppHistoryPath(path: string): void {
  const nextState: AppHistoryState = {
    __nostrSpa: true,
    scrollX: 0,
    scrollY: 0,
  };
  window.history.pushState(nextState, '', path);
}

export function replaceAppHistoryPath(path: string): void {
  const nextState: AppHistoryState = {
    __nostrSpa: true,
    scrollX: 0,
    scrollY: 0,
  };
  window.history.replaceState(nextState, '', path);
}

export async function restoreScrollFromState(state: unknown): Promise<void> {
  const s: any = state;
  const x: number = typeof s?.scrollX === 'number' ? s.scrollX : 0;
  const y: number = typeof s?.scrollY === 'number' ? s.scrollY : 0;

  // Timeline rendering is async; give layout a couple of frames, then try a few times.
  for (let i: number = 0; i < 10; i += 1) {
    await new Promise<void>((resolve: () => void): void => {
      window.requestAnimationFrame((): void => {
        window.requestAnimationFrame((): void => resolve());
      });
    });
    window.scrollTo(x, y);
    if (Math.abs(window.scrollY - y) <= 2) {
      return;
    }
    await new Promise<void>((resolve: () => void): void => {
      window.setTimeout(resolve, 60);
    });
  }
}

export function getRestoreTimelineCount(
  state: unknown,
  expectedType: 'home' | 'global',
): number {
  if (!state || typeof state !== 'object') {
    return 0;
  }
  const s: any = state;
  const timeline = s?.timeline;
  if (!timeline || typeof timeline !== 'object') {
    return 0;
  }
  if (timeline.type !== expectedType) {
    return 0;
  }
  const count: number = typeof timeline.count === 'number' ? timeline.count : 0;
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// Pagination ("Load more") is currently disabled for stability.
export async function restoreTimelineFromCache(params: {
  type: 'home' | 'global';
  userPubkey?: PubkeyHex | undefined;
  desiredCount: number;
  isRouteActive: () => boolean;
}): Promise<{
  restored: boolean;
  oldestTimestamp: number;
  newestTimestamp: number;
}> {
  if (!output || !params.isRouteActive()) {
    return { restored: false, oldestTimestamp: 0, newestTimestamp: 0 };
  }

  const desiredCount: number = Math.max(1, Math.min(params.desiredCount, 500));
  const cached = await getCachedTimeline(params.type, params.userPubkey, {
    limit: desiredCount,
  });
  if (!params.isRouteActive()) {
    return { restored: false, oldestTimestamp: 0, newestTimestamp: 0 };
  }
  if (!cached.hasCache || cached.events.length === 0) {
    return { restored: false, oldestTimestamp: 0, newestTimestamp: 0 };
  }

  // Render cached events (no relay fetch). This is used for browser back/forward restore.
  output.innerHTML = '';
  seenEventIds.clear();

  const uniquePubkeys: PubkeyHex[] = Array.from(
    new Set(cached.events.map((e: NostrEvent) => e.pubkey as PubkeyHex)),
  );
  const profiles: Array<NostrProfile | null> = await Promise.all(
    uniquePubkeys.map(async (pk: PubkeyHex): Promise<NostrProfile | null> => {
      try {
        const cachedDbProfile: NostrProfile | null = await getCachedDbProfile(pk);
        if (cachedDbProfile) {
          return cachedDbProfile;
        }
        return getPersistentCachedProfile(pk);
      } catch {
        return getPersistentCachedProfile(pk);
      }
    }),
  );
  const profileMap: Map<PubkeyHex, NostrProfile | null> = new Map(
    uniquePubkeys.map((pk: PubkeyHex, i: number) => [pk, profiles[i] ?? null]),
  );

  for (const event of cached.events) {
    if (!params.isRouteActive()) {
      return { restored: false, oldestTimestamp: 0, newestTimestamp: 0 };
    }
    seenEventIds.add(event.id);
    const profile: NostrProfile | null =
      profileMap.get(event.pubkey as PubkeyHex) || null;
    const npubStr: Npub = nip19.npubEncode(event.pubkey);
    renderEvent(event, profile, npubStr, event.pubkey, output);
  }

  if (connectingMsg) {
    connectingMsg.style.display = 'none';
  }

  const loadMoreBtn: HTMLButtonElement | null = document.getElementById(
    'load-more',
  ) as HTMLButtonElement | null;
  if (loadMoreBtn) {
    loadMoreBtn.disabled = false;
    loadMoreBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    loadMoreBtn.style.display = 'inline';
  }

  return {
    restored: true,
    oldestTimestamp: cached.oldestTimestamp,
    newestTimestamp: cached.newestTimestamp,
  };
}

export function syncRelays(): void {
  appState.relays = getRelays();
}

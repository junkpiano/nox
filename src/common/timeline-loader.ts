import { nip19 } from 'nostr-tools';
import type { ConnectionStatePacket, EventPacket } from 'rx-nostr';
import type { Subscription } from 'rxjs';
import type {
  NostrEvent,
  NostrFilter,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../types/nostr.js';
import type { CachedTimelineResult, TimelineType } from './db/index.js';
import {
  appendEventsToTimeline,
  getProfile as getCachedDbProfile,
  getCachedTimeline,
  prependEventsToTimeline,
  storeEvents,
} from './db/index.js';
import { renderEvent } from './event-render.js';
import { fetchingProfiles, profileCache } from './timeline-cache.js';
import { getAvatarURL, getDisplayName } from '../utils/utils.js';
import {
  fetchProfile,
  getAuthoritativeProfile,
} from '../features/profile/profile.js';
import { getCachedProfile as getPersistentCachedProfile } from '../features/profile/profile-cache.js';
import { getRelays } from '../features/relays/relays.js';
import { createBackwardReq, getRxNostr } from '../features/relays/rx-nostr-client.js';

type TimelineRenderMode = 'append' | 'sorted-batch';
type TimelineReceiveMode = 'immediate' | 'buffered';
type TimelineProfileMode = 'dynamic' | 'static';
type ConnectingVisibilityMode = 'always' | 'when-empty';

interface TimelineCacheOptions {
  enabled?: boolean | undefined;
  limit?: number | undefined;
  maxAgeMinutes: number;
  getNewestTimestamp?: ((cached: CachedTimelineResult) => number) | undefined;
}

export interface TimelineRuntimeContext {
  relays: string[];
  bufferedEvents: NostrEvent[];
  renderedEventIds: Set<string>;
  seenEventIds: Set<string>;
  eventsReceivedCount: number;
  relayConnectionCount: number;
  relayCompletionCount: number;
  isInitialLoad: boolean;
  filter: NostrFilter;
  limit: number;
  output: HTMLElement;
  getUntilTimestamp: () => number;
}

interface LoadTimelineOptions {
  logPrefix: string;
  timelineType: TimelineType;
  timelinePubkey?: PubkeyHex | undefined;
  limit: number;
  untilTimestamp: number;
  seenEventIds: Set<string>;
  output: HTMLElement;
  connectingMsg: HTMLElement | null;
  createFilter: (untilTimestamp: number) => NostrFilter;
  activeTimeouts?: number[] | undefined;
  isRouteActive?: (() => boolean) | undefined;
  cache?: TimelineCacheOptions | undefined;
  renderMode?: TimelineRenderMode | undefined;
  receiveMode?: TimelineReceiveMode | undefined;
  profileMode?: TimelineProfileMode | undefined;
  staticProfile?: NostrProfile | null | undefined;
  persistEvents?: boolean | undefined;
  isHomeTimelineStorage?: boolean | undefined;
  showConnectingWhen?: ConnectingVisibilityMode | undefined;
  finalizeOnComplete?: boolean | undefined;
  finalizeOnError?: boolean | undefined;
  timeoutMs?: number | undefined;
  onUntilTimestampChange?: ((value: number) => void) | undefined;
  onConnectionState?:
    | ((state: ConnectionStatePacket, context: TimelineRuntimeContext) => void)
    | undefined;
  onEventAccepted?:
    | ((packet: EventPacket, context: TimelineRuntimeContext) => void)
    | undefined;
  onSubscriptionError?:
    | ((error: unknown, context: TimelineRuntimeContext) => void)
    | undefined;
  onSubscriptionComplete?:
    | ((context: TimelineRuntimeContext) => void)
    | undefined;
  onTimeout?: ((context: TimelineRuntimeContext) => void) | undefined;
  onEmpty?: ((context: TimelineRuntimeContext) => void) | undefined;
  onFinalize?: ((context: TimelineRuntimeContext) => void) | undefined;
}

async function getCachedRenderProfile(
  pubkey: PubkeyHex,
  profileMode: TimelineProfileMode,
  staticProfile: NostrProfile | null,
): Promise<NostrProfile | null> {
  if (profileMode === 'static') {
    return staticProfile;
  }

  if (profileCache.has(pubkey)) {
    return profileCache.get(pubkey) || null;
  }

  let profile: NostrProfile | null = await getCachedDbProfile(pubkey);
  if (!profile) {
    profile = getPersistentCachedProfile(pubkey);
  }
  if (profile) {
    profileCache.set(pubkey, profile);
  }

  return profile;
}

function updateRenderedProfile(
  output: HTMLElement,
  event: NostrEvent,
  fetchedProfile: NostrProfile,
): void {
  const renderProfile: NostrProfile | null = getAuthoritativeProfile(
    event.pubkey as PubkeyHex,
    fetchedProfile,
  );
  const eventElements: NodeListOf<Element> =
    output.querySelectorAll('.event-container');
  eventElements.forEach((el: Element): void => {
    if ((el as HTMLElement).dataset.pubkey === event.pubkey) {
      const nameEl: Element | null = el.querySelector('.event-username');
      const avatarEl: Element | null = el.querySelector('.event-avatar');
      if (nameEl) {
        const npubStr: Npub = nip19.npubEncode(event.pubkey);
        nameEl.textContent = `👤 ${getDisplayName(npubStr, renderProfile)}`;
      }
      if (avatarEl) {
        (avatarEl as HTMLImageElement).src = getAvatarURL(event.pubkey, renderProfile);
      }
    }
  });
}

function getLiveRenderProfile(
  event: NostrEvent,
  output: HTMLElement,
  relays: string[],
  routeIsActive: () => boolean,
): NostrProfile | null {
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
        (cachedProfile: NostrProfile | null): void => {
          if (!routeIsActive() || !cachedProfile) {
            return;
          }
          profileCache.set(event.pubkey, cachedProfile);
          updateRenderedProfile(output, event, cachedProfile);
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
        if (!routeIsActive()) {
          return;
        }
        fetchingProfiles.delete(event.pubkey);
        if (!fetchedProfile) {
          return;
        }
        profileCache.set(event.pubkey, fetchedProfile);
        updateRenderedProfile(output, event, fetchedProfile);
      })
      .catch((error: unknown): void => {
        console.error(`Failed to fetch profile for ${event.pubkey}`, error);
        fetchingProfiles.delete(event.pubkey);
      });
  }

  return getAuthoritativeProfile(event.pubkey as PubkeyHex, profile);
}

function insertRenderedEventSorted(
  output: HTMLElement,
  event: NostrEvent,
  profile: NostrProfile | null,
  npubStr: Npub,
): void {
  const staging: HTMLDivElement = document.createElement('div');
  renderEvent(event, profile, npubStr, event.pubkey, staging);
  const node: Element | null = staging.firstElementChild;
  if (!node) {
    return;
  }

  const children: HTMLCollection = output.children;
  for (let i: number = 0; i < children.length; i += 1) {
    const el: HTMLElement = children[i] as HTMLElement;
    if (!el.classList?.contains('event-container')) {
      continue;
    }
    const createdAtRaw: string | undefined = el.dataset.createdAt;
    const createdAt: number = createdAtRaw ? Number(createdAtRaw) : NaN;
    if (!Number.isFinite(createdAt)) {
      continue;
    }
    if (createdAt < event.created_at) {
      output.insertBefore(node, el);
      return;
    }
  }

  output.appendChild(node);
}

function renderTimelineEvent(
  output: HTMLElement,
  event: NostrEvent,
  profile: NostrProfile | null,
  renderMode: TimelineRenderMode,
): void {
  const npubStr: Npub = nip19.npubEncode(event.pubkey);
  if (renderMode === 'sorted-batch') {
    insertRenderedEventSorted(output, event, profile, npubStr);
    return;
  }

  renderEvent(event, profile, npubStr, event.pubkey, output);
}

export async function loadTimeline(options: LoadTimelineOptions): Promise<void> {
  const routeIsActive: () => boolean = options.isRouteActive || (() => true);
  const relays: string[] = getRelays();
  if (!routeIsActive()) {
    return;
  }

  const activeTimeouts: number[] = options.activeTimeouts || [];
  const renderMode: TimelineRenderMode = options.renderMode || 'append';
  const receiveMode: TimelineReceiveMode = options.receiveMode || 'immediate';
  const profileMode: TimelineProfileMode = options.profileMode || 'dynamic';
  const showConnectingWhen: ConnectingVisibilityMode =
    options.showConnectingWhen || 'when-empty';
  const persistEvents: boolean = options.persistEvents !== false;
  const finalizeOnComplete: boolean = options.finalizeOnComplete !== false;
  const finalizeOnError: boolean = options.finalizeOnError !== false;
  const timeoutMs: number = options.timeoutMs || 8000;

  let currentUntilTimestamp: number = options.untilTimestamp;
  options.onUntilTimestampChange?.(currentUntilTimestamp);

  const bufferedEvents: NostrEvent[] = [];
  const renderedEventIds: Set<string> = new Set();
  let relayConnectionCount: number = 0;
  let eventsReceivedCount: number = 0;
  let relayCompletionCount: number = 0;
  let flushScheduled: boolean = false;
  let finalized: boolean = false;
  let clearedPlaceholder: boolean =
    options.output.querySelectorAll('.event-container').length > 0;
  let subscription: Subscription | null = null;
  let mainTimeoutId: number | null = null;

  const isInitialLoad: boolean = currentUntilTimestamp >= Date.now() / 1000 - 60;
  const originalUntilTimestamp: number = currentUntilTimestamp;

  let filter: NostrFilter = options.createFilter(currentUntilTimestamp);

  const getContext = (): TimelineRuntimeContext => ({
    relays,
    bufferedEvents,
    renderedEventIds,
    seenEventIds: options.seenEventIds,
    eventsReceivedCount,
    relayConnectionCount,
    relayCompletionCount,
    isInitialLoad,
    filter,
    limit: options.limit,
    output: options.output,
    getUntilTimestamp: (): number => currentUntilTimestamp,
  });

  const cacheOptions: TimelineCacheOptions | undefined = options.cache;

  if (isInitialLoad && cacheOptions && cacheOptions.enabled !== false) {
    const activeCacheOptions: TimelineCacheOptions = cacheOptions;
    try {
      const cached: CachedTimelineResult = await getCachedTimeline(
        options.timelineType,
        options.timelinePubkey,
        { limit: activeCacheOptions.limit || 50 },
      );
      const newestTimestamp: number =
        activeCacheOptions.getNewestTimestamp?.(cached) ?? cached.newestTimestamp;
      const cacheAgeMinutes = cached.hasCache
        ? Math.floor((Date.now() / 1000 - newestTimestamp) / 60)
        : 0;
      const isCacheStale = cacheAgeMinutes > activeCacheOptions.maxAgeMinutes;

      if (cached.hasCache && cached.events.length > 0) {
        console.log(
          `[${options.logPrefix}] Loaded ${cached.events.length} events from cache (age: ${cacheAgeMinutes} minutes, ${isCacheStale ? 'STALE' : 'fresh'})`,
        );

        if (isCacheStale) {
          console.log(
            `[${options.logPrefix}] Cache is stale (>${activeCacheOptions.maxAgeMinutes}m), skipping cache display`,
          );
        } else {
          if (!routeIsActive()) {
            return;
          }
          clearedPlaceholder = true;
          options.output.innerHTML = '';

          if (routeIsActive()) {
            for (const event of cached.events) {
              if (
                renderedEventIds.has(event.id) ||
                options.seenEventIds.has(event.id)
              ) {
                continue;
              }
              renderedEventIds.add(event.id);
              options.seenEventIds.add(event.id);

              const profile: NostrProfile | null = await getCachedRenderProfile(
                event.pubkey as PubkeyHex,
                profileMode,
                options.staticProfile || null,
              );
              renderTimelineEvent(
                options.output,
                event,
                profile,
                'append',
              );
            }
          }

          if (options.connectingMsg) {
            options.connectingMsg.style.display = 'none';
          }

          currentUntilTimestamp = originalUntilTimestamp;
          options.onUntilTimestampChange?.(currentUntilTimestamp);
        }
      }
    } catch (error) {
      console.error(`[${options.logPrefix}] Failed to load from cache:`, error);
    }
  }

  if (
    options.connectingMsg &&
    (showConnectingWhen === 'always' || !clearedPlaceholder)
  ) {
    options.connectingMsg.style.display = '';
  }

  const rxNostr = getRxNostr();
  const req = createBackwardReq();
  filter = options.createFilter(currentUntilTimestamp);

  console.log(`[${options.logPrefix}] Fetching events with filter:`, filter);

  let connectionSub: Subscription | null = null;
  if (options.onConnectionState) {
    connectionSub = rxNostr.createConnectionStateObservable().subscribe({
      next: (state: ConnectionStatePacket): void => {
        if (state.state === 'connected') {
          relayConnectionCount += 1;
        }
        options.onConnectionState?.(state, getContext());
      },
    });
  }

  const renderOne = (event: NostrEvent): void => {
    if (!routeIsActive()) {
      return;
    }
    if (renderedEventIds.has(event.id)) {
      return;
    }
    renderedEventIds.add(event.id);

    if (!clearedPlaceholder) {
      options.output.innerHTML = '';
      clearedPlaceholder = true;
    }

    const profile: NostrProfile | null =
      profileMode === 'static'
        ? options.staticProfile || null
        : getLiveRenderProfile(event, options.output, relays, routeIsActive);
    renderTimelineEvent(options.output, event, profile, renderMode);

    currentUntilTimestamp = Math.min(currentUntilTimestamp, event.created_at);
    options.onUntilTimestampChange?.(currentUntilTimestamp);
  };

  const flushBufferedEvents = (): void => {
    if (!routeIsActive()) {
      return;
    }

    if (renderMode === 'sorted-batch') {
      bufferedEvents.sort(
        (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
      );
    }

    bufferedEvents.forEach((event: NostrEvent): void => {
      renderOne(event);
    });

    if (options.connectingMsg && renderedEventIds.size > 0) {
      options.connectingMsg.style.display = 'none';
    }
  };

  const persistBufferedTimeline = (): void => {
    if (!persistEvents || bufferedEvents.length === 0) {
      return;
    }

    storeEvents(bufferedEvents, {
      isHomeTimeline: options.isHomeTimelineStorage === true,
    }).catch((error) => {
      console.error(`[${options.logPrefix}] Failed to store events:`, error);
    });

    const eventIds: string[] = bufferedEvents.map((event) => event.id);
    const timestamps: number[] = bufferedEvents.map((event) => event.created_at);
    const newestTimestamp: number = Math.max(...timestamps);
    const oldestTimestamp: number = Math.min(...timestamps);

    if (isInitialLoad) {
      prependEventsToTimeline(
        options.timelineType,
        options.timelinePubkey,
        eventIds,
        newestTimestamp,
      ).catch((error) => {
        console.error(`[${options.logPrefix}] Failed to update timeline:`, error);
      });
      return;
    }

    appendEventsToTimeline(
      options.timelineType,
      options.timelinePubkey,
      eventIds,
      oldestTimestamp,
    ).catch((error) => {
      console.error(
        `[${options.logPrefix}] Failed to append to timeline:`,
        error,
      );
    });
  };

  const finalizeLoading = (): void => {
    if (!routeIsActive() || finalized) {
      return;
    }
    finalized = true;

    if (mainTimeoutId !== null) {
      clearTimeout(mainTimeoutId);
      mainTimeoutId = null;
    }

    flushBufferedEvents();
    persistBufferedTimeline();

    const hasRenderedEvents: boolean =
      options.output.querySelectorAll('.event-container').length > 0;
    if (!hasRenderedEvents && options.seenEventIds.size === 0) {
      options.onEmpty?.(getContext());
    }

    if (options.connectingMsg) {
      options.connectingMsg.style.display = 'none';
    }

    subscription?.unsubscribe();
    connectionSub?.unsubscribe();
    options.onFinalize?.(getContext());
  };

  const scheduleFlush = (): void => {
    if (receiveMode !== 'buffered' || flushScheduled) {
      return;
    }
    flushScheduled = true;
    const timeoutId = window.setTimeout((): void => {
      flushScheduled = false;
      flushBufferedEvents();
    }, 300);
    activeTimeouts.push(timeoutId);
  };

  subscription = rxNostr.use(req, { relays }).subscribe({
    next: (packet: EventPacket): void => {
      if (!routeIsActive()) {
        subscription?.unsubscribe();
        connectionSub?.unsubscribe();
        return;
      }

      eventsReceivedCount += 1;

      const event: NostrEvent = packet.event;
      if (options.seenEventIds.has(event.id)) {
        return;
      }
      options.seenEventIds.add(event.id);
      bufferedEvents.push(event);
      options.onEventAccepted?.(packet, getContext());

      if (options.connectingMsg) {
        options.connectingMsg.style.display = 'none';
      }

      if (receiveMode === 'buffered') {
        scheduleFlush();
        return;
      }

      renderOne(event);
    },
    error: (error: unknown): void => {
      if (!routeIsActive()) {
        return;
      }

      options.onSubscriptionError?.(error, getContext());
      if (finalizeOnError) {
        finalizeLoading();
        return;
      }

      connectionSub?.unsubscribe();
    },
    complete: (): void => {
      relayCompletionCount = relays.length;
      options.onSubscriptionComplete?.(getContext());
      if (finalizeOnComplete) {
        finalizeLoading();
        return;
      }

      connectionSub?.unsubscribe();
    },
  });

  req.emit(filter);

  mainTimeoutId = window.setTimeout((): void => {
    options.onTimeout?.(getContext());
    finalizeLoading();
  }, timeoutMs);
  activeTimeouts.push(mainTimeoutId);
}

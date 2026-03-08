import type { ConnectionStatePacket } from 'rx-nostr';
import { getRelays } from '../relays/relays.js';
import { getRxNostr } from '../relays/rx-nostr-client.js';
import { loadTimeline, type TimelineRuntimeContext } from '../../common/timeline-loader.js';

export async function loadGlobalTimeline(
  _relays: string[],
  limit: number,
  untilTimestamp: number,
  seenEventIds: Set<string>,
  output: HTMLElement,
  connectingMsg: HTMLElement | null,
  _activeWebSockets: WebSocket[] = [],
  activeTimeouts: number[] = [],
  isRouteActive?: () => boolean,
): Promise<void> {
  const relays = getRelays();
  const routeIsActive: () => boolean = isRouteActive || (() => true);
  if (!routeIsActive()) {
    return;
  }
  const rxNostr = getRxNostr();
  console.log('[GlobalTimeline] RxNostr instance:', {
    isInitialized: !!rxNostr,
    relaysConfigured: relays.length,
    relaysList: relays,
  });
  console.log('[GlobalTimeline] Starting subscription for relays:', relays);

  await loadTimeline({
    logPrefix: 'GlobalTimeline',
    timelineType: 'global',
    limit,
    untilTimestamp,
    seenEventIds,
    output,
    connectingMsg,
    activeTimeouts,
    isRouteActive: routeIsActive,
    createFilter: (currentUntilTimestamp) => ({
      kinds: [1, 6, 16],
      until: currentUntilTimestamp,
      limit,
    }),
    cache: {
      maxAgeMinutes: 10,
      limit: 50,
    },
    renderMode: 'append',
    receiveMode: 'immediate',
    profileMode: 'dynamic',
    persistEvents: true,
    isHomeTimelineStorage: false,
    showConnectingWhen: 'when-empty',
    finalizeOnComplete: false,
    finalizeOnError: false,
    onConnectionState: (
      state: ConnectionStatePacket,
      _context: TimelineRuntimeContext,
    ): void => {
      console.log(`[GlobalTimeline] Relay ${state.from}:`, state.state);
    },
    onEventAccepted: (packet, context): void => {
      const event = packet.event;
      const eventAge = Math.floor((Date.now() / 1000 - event.created_at) / 60);
      console.log(
        `[GlobalTimeline] Event #${context.eventsReceivedCount} from ${packet.from}:`,
        {
          eventId: event.id.slice(0, 8),
          kind: event.kind,
          age: `${eventAge}m ago`,
        },
      );
    },
    onSubscriptionError: (error, context): void => {
      if (!routeIsActive()) {
        return;
      }
      console.error('[GlobalTimeline] Subscription error:', {
        error,
        eventsReceived: context.eventsReceivedCount,
        relayCompletions: context.relayCompletionCount,
      });
      if (connectingMsg) {
        connectingMsg.style.display = 'none';
      }
    },
    onSubscriptionComplete: (context): void => {
      console.log('[GlobalTimeline] Subscription complete (EOSE or timeout):', {
        newEventsFromRelay: context.bufferedEvents.length,
        eventsReceived: context.eventsReceivedCount,
        bufferedEvents: context.bufferedEvents.length,
        relaysUsed: context.relays.length,
      });
    },
    onTimeout: (context): void => {
      console.log('[GlobalTimeline] Timeout reached:', {
        eventsReceived: context.eventsReceivedCount,
        bufferedEvents: context.bufferedEvents.length,
        relayConnections: context.relayConnectionCount,
        seenEventIds: context.seenEventIds.size,
      });
    },
    onEmpty: (context): void => {
      if (!routeIsActive()) {
        return;
      }
      console.warn('[GlobalTimeline] No events loaded:', {
        relayConnectionCount: context.relayConnectionCount,
        eventsReceivedCount: context.eventsReceivedCount,
        relayCompletionCount: context.relayCompletionCount,
        relays: context.relays.length,
        filter: context.filter,
      });
      output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-gray-700 mb-4">No events found on global timeline.</p>
          <p class="text-gray-500 text-sm mb-2">This could mean:</p>
          <ul class="text-gray-500 text-sm list-disc list-inside mb-4">
            <li>Relays are not responding (check console)</li>
            <li>Network connectivity issues</li>
            <li>Relays are temporarily down</li>
          </ul>
          <p class="text-gray-600 text-sm">
            Try refreshing the page or check
            <a href="/relays" class="text-indigo-600 hover:underline">Relay settings</a>.
          </p>
          <p class="text-gray-500 text-xs mt-4">
            Connected to ${context.relayConnectionCount}/${context.relays.length} relays
          </p>
        </div>
      `;
    },
  });
}

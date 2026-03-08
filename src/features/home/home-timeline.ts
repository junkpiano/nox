import type { PubkeyHex } from '../../../types/nostr';
import { loadTimeline } from '../../common/timeline-loader.js';
import { getRelays } from '../relays/relays.js';

export async function loadHomeTimeline(
  followedPubkeys: PubkeyHex[],
  kinds: number[],
  _relays: string[],
  limit: number,
  untilTimestamp: number,
  seenEventIds: Set<string>,
  output: HTMLElement,
  connectingMsg: HTMLElement | null,
  _activeWebSockets: WebSocket[] = [],
  activeTimeouts: number[] = [],
  isRouteActive?: () => boolean,
  userPubkey?: PubkeyHex | undefined,
): Promise<void> {
  const routeIsActive: () => boolean = isRouteActive || (() => true);
  if (!routeIsActive()) {
    return;
  }

  if (followedPubkeys.length === 0) {
    if (output) {
      if (!routeIsActive()) return; // Guard before DOM update
      output.innerHTML = `
                <div class="text-center py-8">
                    <p class="text-gray-700 mb-4">No authors specified for home timeline.</p>
                </div>
            `;
    }
    return;
  }

  const relays = getRelays();
  await loadTimeline({
    logPrefix: 'HomeTimeline',
    timelineType: 'home',
    timelinePubkey: userPubkey,
    limit,
    untilTimestamp,
    seenEventIds,
    output,
    connectingMsg,
    activeTimeouts,
    isRouteActive: routeIsActive,
    createFilter: (currentUntilTimestamp) => ({
      kinds,
      authors: followedPubkeys,
      until: currentUntilTimestamp,
      limit,
    }),
    cache: {
      enabled: Boolean(userPubkey),
      limit: 50,
      maxAgeMinutes: 30,
      getNewestTimestamp: (cached) =>
        cached.events.length > 0
          ? Math.max(...cached.events.map((event) => event.created_at))
          : cached.newestTimestamp,
    },
    renderMode: 'sorted-batch',
    receiveMode: 'buffered',
    profileMode: 'dynamic',
    persistEvents: Boolean(userPubkey),
    isHomeTimelineStorage: true,
    showConnectingWhen: 'always',
    onEventAccepted: (packet): void => {
      const event = packet.event;
      console.log(
        `[HomeTimeline] Received event ${event.id} from ${packet.from} (kind ${event.kind})`,
      );
    },
    onSubscriptionError: (error): void => {
      if (!routeIsActive()) {
        return;
      }
      console.error('[HomeTimeline] Subscription error:', error);
      if (connectingMsg) {
        connectingMsg.style.display = 'none';
      }
    },
    onSubscriptionComplete: (context): void => {
      console.log(
        `[HomeTimeline] Subscription complete. Received ${context.bufferedEvents.length} events.`,
      );
    },
    onTimeout: (): void => {
      console.warn('Timeline loading timed out, forcing finalization');
    },
    onEmpty: (): void => {
      if (!routeIsActive()) {
        return;
      }
      console.warn(
        `[HomeTimeline] No events found. Authors: ${followedPubkeys.length}, Kinds: ${kinds.join(', ')}, Relays: ${relays.length}`,
      );
      output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-gray-700 mb-4">No posts found in your home timeline.</p>
          <p class="text-gray-500 text-sm mb-2">This could mean:</p>
          <ul class="text-gray-500 text-sm list-disc list-inside mb-4">
            <li>The people you follow haven't posted recently</li>
            <li>Your relays are not responding</li>
            <li>You're not following anyone yet</li>
          </ul>
          <p class="text-gray-600 text-sm">Try viewing the <a href="/global" class="text-indigo-600 hover:underline">Global Timeline</a> or check your <a href="/relays" class="text-indigo-600 hover:underline">Relay settings</a>.</p>
        </div>
      `;
    },
  });
}

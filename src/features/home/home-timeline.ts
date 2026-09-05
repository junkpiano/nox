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
        <div class="nox-empty-state">
          <h3 class="nox-panel-title">Nothing here yet</h3>
          <p class="nox-panel-copy">Home shows posts from people you follow. Find people on the <a href="/global">Global timeline</a>.</p>
          <p class="nox-panel-copy">Already following people? Check <a href="/relays">Relays</a>.</p>
        </div>
      `;
    },
  });
}

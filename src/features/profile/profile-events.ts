import type {
  NostrProfile,
  PubkeyHex,
} from '../../../types/nostr';
import { loadTimeline } from '../../common/timeline-loader.js';
import { getRelays } from '../relays/relays.js';

export async function loadEvents(
  pubkeyHex: PubkeyHex,
  profile: NostrProfile | null,
  _relays: string[],
  limit: number,
  untilTimestamp: number,
  seenEventIds: Set<string>,
  output: HTMLElement,
  connectingMsg: HTMLElement | null,
  isRouteActive?: () => boolean,
): Promise<void> {
  const routeIsActive: () => boolean = isRouteActive || (() => true);
  const relays = getRelays();
  if (!routeIsActive()) {
    return;
  }
  const loadMoreBtn: HTMLElement | null = document.getElementById('load-more');
  let nextUntilTimestamp: number = untilTimestamp;

  if (loadMoreBtn) {
    (loadMoreBtn as HTMLButtonElement).disabled = true; // Disable the button while loading
    loadMoreBtn.classList.add('opacity-50', 'cursor-not-allowed'); // Add styles to indicate it's disabled
  }

  await loadTimeline({
    logPrefix: 'ProfileEvents',
    timelineType: 'user',
    timelinePubkey: pubkeyHex,
    limit,
    untilTimestamp,
    seenEventIds,
    output,
    connectingMsg,
    isRouteActive: routeIsActive,
    createFilter: (currentUntilTimestamp) => ({
      kinds: [1, 6, 16],
      authors: [pubkeyHex],
      until: currentUntilTimestamp,
      limit,
    }),
    cache: {
      limit: 50,
      maxAgeMinutes: 30,
    },
    renderMode: 'append',
    receiveMode: 'immediate',
    profileMode: 'static',
    staticProfile: profile,
    persistEvents: true,
    isHomeTimelineStorage: false,
    showConnectingWhen: 'when-empty',
    onUntilTimestampChange: (value): void => {
      nextUntilTimestamp = value;
    },
    onSubscriptionError: (error): void => {
      if (!routeIsActive()) {
        return;
      }
      console.error('[ProfileEvents] Subscription error:', error);
    },
    onSubscriptionComplete: (context): void => {
      console.log(
        `[ProfileEvents] Subscription complete. Received ${context.bufferedEvents.length} events.`,
      );
    },
    onTimeout: (): void => {
      console.warn(
        '[ProfileEvents] Timeline loading timed out, forcing finalization',
      );
    },
    onEmpty: (): void => {
      if (!routeIsActive()) {
        return;
      }
      console.warn(`[ProfileEvents] No events found for user: ${pubkeyHex}`);
      output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-gray-700 mb-4">No posts found for this user.</p>
          <p class="text-gray-500 text-sm">This user may not have posted yet, or relays are not responding.</p>
        </div>
      `;
    },
    onFinalize: (): void => {
      const hasRenderedEvents =
        output.querySelectorAll('.event-container').length > 0;
      if (connectingMsg) {
        connectingMsg.style.display = 'none';
      }
      if (loadMoreBtn) {
        (loadMoreBtn as HTMLButtonElement).disabled = false;
        loadMoreBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        if (hasRenderedEvents) {
          loadMoreBtn.style.display = 'inline';
        }
      }
    },
  });

  if (loadMoreBtn) {
    const newLoadMoreBtn: HTMLElement = loadMoreBtn.cloneNode(
      true,
    ) as HTMLElement;
    loadMoreBtn.parentNode?.replaceChild(newLoadMoreBtn, loadMoreBtn);
    newLoadMoreBtn.addEventListener(
      'click',
      (): Promise<void> =>
        loadEvents(
          pubkeyHex,
          profile,
          relays,
          limit,
          nextUntilTimestamp,
          seenEventIds,
          output,
          connectingMsg,
          routeIsActive,
        ),
    );
  }
}

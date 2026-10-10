/**
 * Posts carrying one hashtag: the `#t` tag NIP-12 indexes, not a text search.
 *
 * Written as the global timeline is, with a narrower filter. Nothing is
 * stored: the events go to the main cache through every other path that
 * shows them, and a hashtag has no timeline of its own to resume.
 */

import { escapeHtml } from '../../common/escape-html.js';
import { loadTimeline } from '../../common/timeline-loader.js';

export async function loadHashtagTimeline(params: {
  tag: string;
  limit: number;
  untilTimestamp: number;
  seenEventIds: Set<string>;
  output: HTMLElement;
  connectingMsg: HTMLElement | null;
  activeTimeouts: number[];
  isRouteActive: () => boolean;
}): Promise<void> {
  const { tag, output, isRouteActive } = params;
  await loadTimeline({
    logPrefix: 'HashtagTimeline',
    // Required by the loader; with persistEvents off, it is never written.
    timelineType: 'global',
    limit: params.limit,
    untilTimestamp: params.untilTimestamp,
    seenEventIds: params.seenEventIds,
    output,
    connectingMsg: params.connectingMsg,
    activeTimeouts: params.activeTimeouts,
    isRouteActive,
    createFilter: (until: number) => ({
      kinds: [1],
      '#t': [tag],
      until,
      limit: params.limit,
    }),
    renderMode: 'append',
    receiveMode: 'immediate',
    profileMode: 'dynamic',
    persistEvents: false,
    showConnectingWhen: 'when-empty',
    finalizeOnComplete: false,
    finalizeOnError: false,
    onEmpty: (): void => {
      if (!isRouteActive()) return;
      output.innerHTML = `
        <div class="text-center py-8">
          <p class="text-gray-600">No posts tagged #${escapeHtml(tag)} on your relays yet.</p>
        </div>
      `;
    },
  });
}

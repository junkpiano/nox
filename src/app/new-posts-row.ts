/**
 * The row at the top of a timeline that says new posts are waiting.
 *
 * Every thirty seconds the relays are asked for anything newer than what is
 * on screen. What comes back does not go into the list: it waits, and one
 * thin row between the header and the first post says how many. The row is
 * part of the list - it scrolls away like a post, it does not float over
 * the words somebody is reading - and a click lets the waiting posts in at
 * the top, removes the row and scrolls there.
 *
 * The count is of posts a click will actually add. Muted authors and words,
 * withdrawn posts and machine-written ones are removed before they are
 * counted, so the row never promises twelve and delivers nine.
 *
 * The rule for what is new lives in `src/common/new-posts.ts`, shared with
 * the native app; this file is the web's polling and the web's row.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { storeEvents } from '../common/db/events-store.js';
import { prependEventsToTimeline } from '../common/db/timelines-store.js';
import { fetchDeletedIds, withoutDeleted } from '../common/deleted-events.js';
import { isMachineContent } from '../common/machine-content.js';
import { filterMutedEvents } from '../common/mute-state.js';
import {
  createNewPostsBuffer,
  type NewPostsBuffer,
  newPostsLabel,
  nextSince,
} from '../common/new-posts.js';
import { queryRelays } from '../common/relay-query.js';
import { unwrapRepost } from '../common/repost.js';
import { renderIncomingEvent } from '../common/timeline-loader.js';
import { applyStatusesToTimeline } from '../common/timeline-status.js';
import { appState, output, seenEventIds } from './app-state.js';

const POLL_MS: number = 30000;
/** A poll is small; anything more is a reload. */
const POLL_LIMIT: number = 50;
const ROW_ID: string = 'new-posts-row';

export interface NewPostsSource {
  timelineType: 'home' | 'global';
  /** Whose home timeline, for the cache; absent for global. */
  timelinePubkey?: PubkeyHex;
  /** The question the timeline asked, without `until`, `since` or `limit`. */
  filter: Record<string, unknown>;
}

let source: NewPostsSource | null = null;
let timer: number | null = null;
let polling: boolean = false;
/** The newest moment heard of, shown or waiting. */
let newestSeen: number | null = null;
let routeIsActive: () => boolean = (): boolean => false;

const waiting: NewPostsBuffer<NostrEvent> = createNewPostsBuffer<NostrEvent>({
  keyOf: (event: NostrEvent): string => event.id,
  isShown: (id: string): boolean => seenEventIds.has(id),
  createdAt: (event: NostrEvent): number => event.created_at,
});

/** Starts polling for the timeline on screen. Replaces any earlier one. */
export function startNewPostsPolling(next: NewPostsSource): void {
  stopNewPostsPolling();
  clearNewPosts();
  source = next;
  newestSeen = null;
  // The route's own token, read rather than renewed: `createRouteGuard()`
  // advances it, which would tell the timeline still loading beside this
  // that it had been navigated away from.
  const token: number = appState.activeRouteToken;
  routeIsActive = (): boolean => token === appState.activeRouteToken;
  timer = window.setInterval((): void => {
    void pollForNewPosts();
  }, POLL_MS);
}

/** Stops asking. What is already waiting stays until `clearNewPosts`. */
export function stopNewPostsPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  source = null;
}

/** Forgets the waiting posts and removes the row - on leaving the timeline. */
export function clearNewPosts(): void {
  waiting.clear();
  document.getElementById(ROW_ID)?.remove();
}

/** The newest post on screen, from the cards themselves. */
function newestShown(): number | null {
  if (!output) return null;
  let newest: number | null = null;
  for (const card of Array.from(
    output.querySelectorAll<HTMLElement>('.event-container'),
  )) {
    const createdAt: number = Number(card.dataset.createdAt);
    if (Number.isFinite(createdAt) && (newest === null || createdAt > newest)) {
      newest = createdAt;
    }
  }
  return newest;
}

/**
 * What a click would actually show.
 *
 * The same judgements the card makes when it is drawn, made here so the
 * count is honest: the mute list on the author and on whoever passed a
 * repost on, machine content on what would be shown, and the author's own
 * deletion requests.
 */
async function onlyShowable(events: NostrEvent[]): Promise<NostrEvent[]> {
  const readable: NostrEvent[] = events.filter((event: NostrEvent): boolean => {
    const copy: NostrEvent | null = unwrapRepost(event).event;
    const judged: NostrEvent[] =
      copy && copy !== event ? [event, copy] : [event];
    if (filterMutedEvents(judged).length !== judged.length) return false;
    // A repost with no verified copy is judged when its target is fetched,
    // as the card does.
    return !(copy && isMachineContent(copy.content));
  });
  if (readable.length === 0) return [];
  const deleted: Set<string> = await fetchDeletedIds(appState.relays, readable);
  return withoutDeleted(readable, deleted);
}

/** One poll. Also run at once when the service worker reports new events. */
export async function pollForNewPosts(): Promise<void> {
  if (!source || !output || polling) return;
  // Nothing on screen yet means nothing to be newer than; the timeline is
  // still loading and will be polled once it has drawn.
  const since: number | null = nextSince(newestSeen ?? newestShown());
  if (since === null) return;

  polling = true;
  const filter: Record<string, unknown> = source.filter;
  try {
    const events: NostrEvent[] = await queryRelays(appState.relays, {
      ...filter,
      since,
      limit: POLL_LIMIT,
    });
    if (!routeIsActive()) return;
    for (const event of events) {
      if (newestSeen === null || event.created_at > newestSeen) {
        newestSeen = event.created_at;
      }
    }
    const fresh: NostrEvent[] = await onlyShowable(
      events.filter(
        (event: NostrEvent): boolean => !seenEventIds.has(event.id),
      ),
    );
    if (!routeIsActive()) return;
    const count: number = waiting.add(fresh);
    if (count > 0) drawRow(count);
  } catch (error: unknown) {
    console.warn('[NewPosts] Poll failed:', error);
  } finally {
    polling = false;
  }
}

function drawRow(count: number): void {
  if (!output) return;
  let row: HTMLElement | null = document.getElementById(ROW_ID);
  if (!row) {
    row = document.createElement('div');
    row.id = ROW_ID;
    // Deliberately not an `event-container`: the sorted insert, the status
    // lookup and the scroll anchor all treat those as posts.
    row.className = 'new-posts-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML =
      '<span class="new-posts-rule"></span><span class="new-posts-label"></span><span class="new-posts-rule"></span>';
    row.addEventListener('click', (): void => {
      void showNewPosts();
    });
    row.addEventListener('keydown', (event: KeyboardEvent): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void showNewPosts();
      }
    });
    output.prepend(row);
  }
  const label: Element | null = row.querySelector('.new-posts-label');
  if (label) label.textContent = newPostsLabel(count);
}

/** Lets the waiting posts in, removes the row, and goes to the top. */
export async function showNewPosts(): Promise<void> {
  const current: NewPostsSource | null = source;
  if (!output || !current) return;
  const fresh: NostrEvent[] = waiting.take();
  document.getElementById(ROW_ID)?.remove();
  if (fresh.length === 0) return;

  for (const event of fresh) {
    seenEventIds.add(event.id);
    renderIncomingEvent(output, event, appState.relays, routeIsActive);
  }
  void applyStatusesToTimeline(output, appState.relays);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // The cache is the source of truth, so what is on screen goes into it -
  // the same way the timeline's own load records what it drew.
  storeEvents(fresh, {
    isHomeTimeline: current.timelineType === 'home',
  }).catch((error: unknown): void => {
    console.error('[NewPosts] Failed to store events:', error);
  });
  prependEventsToTimeline(
    current.timelineType,
    current.timelinePubkey,
    fresh.map((event: NostrEvent): string => event.id),
    Math.max(...fresh.map((event: NostrEvent): number => event.created_at)),
  ).catch((error: unknown): void => {
    console.error('[NewPosts] Failed to update timeline:', error);
  });
}

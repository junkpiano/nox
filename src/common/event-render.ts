import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  OGPResponse,
  PubkeyHex,
} from '../../types/nostr';
import {
  fetchProfile,
  getAuthoritativeProfile,
} from '../features/profile/profile.js';
import { getRelays, normalizeRelayUrl } from '../features/relays/relays.js';
import {
  fetchOGP,
  getAvatarURL,
  getDisplayName,
  isTwitterURL,
} from '../utils/utils.js';
import { avatarErrorAttribute, fallbackAvatarUrl } from './avatar.js';
import { loadableOnThisPage, setAvatar } from './avatar-dom.js';
import { setCapped } from './capped-map.js';
import { readClientName, withClientTag } from './client-tag.js';
import {
  normalizeHttpUrl,
  type RenderedContent,
  renderContentHtml,
  renderEmojiHtml,
} from './content-html.js';
import {
  type ContentWarning,
  contentWarningSummary,
  getContentWarning,
} from './content-warning.js';
import { deleteEvents, removeEventFromTimeline } from './db/index.js';
import { requestDeletion } from './delete-event.js';
import { computeTimelineRemovalTargets } from './deletion-targets.js';
import { escapeHtml } from './escape-html.js';
import {
  cacheDeletionStatus,
  getCachedDeletionStatus,
  isEventDeleted,
} from './events-queries.js';
import { describeLink, type LinkCard } from './link-card.js';
import { isMachineContent } from './machine-content.js';
import { isMuted } from './mute-state.js';
import { verifiedNip05 } from './nip05.js';
import { noteRenderedCard, recordOwnReaction } from './own-reactions-dom.js';
import { publishEventToRelays } from './publish-event.js';
import type { ReactionAggregate } from './reaction-interactions.js';
import {
  applyOptimisticReactionState,
  filterDeletedReactionEvents,
  findOwnReactionEvents,
  getNextReactionDetailsState,
  getReactionAggregate,
  isReactionClickOnly,
  mergeReactionEvents,
} from './reaction-interactions.js';
import {
  fetchReferencedEvent,
  rememberReferencedMiss,
} from './referenced-event.js';
import { queryRelays } from './relay-query.js';
import { repostTags } from './reply-tags.js';
import { eTagMarker } from './reply-target.js';
import { unwrapRepost } from './repost.js';
import { canWrite, signWithSession } from './signer.js';
import { openZapComposer } from './zap.js';

interface ParentReference {
  eventId: string;
  relayHints: string[];
}

const reactionCache: Map<
  string,
  Promise<Map<string, ReactionAggregate>>
> = new Map();
const reactionEventsCache: Map<string, Promise<NostrEvent[]>> = new Map();
/** Posts whose reactions are remembered; the event page asks for one at a time. */
const MAX_REACTION_MEMO: number = 500;
const optimisticReactionEvents: Map<
  string,
  Map<string, NostrEvent>
> = new Map();
const optimisticRemovedReactionEventIds: Map<string, Set<string>> = new Map();

function invalidateReactionCaches(eventId: string): void {
  reactionCache.delete(eventId);
  reactionEventsCache.delete(eventId);
}

function getOptimisticReactionKey(
  eventId: string,
  reactionKey: string,
): string {
  return `${eventId}:${reactionKey}`;
}

function getOptimisticReactionEvents(
  eventId: string,
  reactionKey: string,
): NostrEvent[] {
  const cacheKey: string = getOptimisticReactionKey(eventId, reactionKey);
  return Array.from(optimisticReactionEvents.get(cacheKey)?.values() || []);
}

function getAllOptimisticReactionEvents(eventId: string): NostrEvent[] {
  const prefix: string = `${eventId}:`;
  const events: NostrEvent[] = [];
  optimisticReactionEvents.forEach(
    (reactionEventsById: Map<string, NostrEvent>, cacheKey: string): void => {
      if (!cacheKey.startsWith(prefix)) {
        return;
      }
      events.push(...Array.from(reactionEventsById.values()));
    },
  );
  return events;
}

function getOptimisticRemovedReactionIds(eventId: string): Set<string> {
  return new Set(optimisticRemovedReactionEventIds.get(eventId) || []);
}

function rememberOptimisticReaction(
  eventId: string,
  reactionKey: string,
  reactionEvent: NostrEvent,
): void {
  const cacheKey: string = getOptimisticReactionKey(eventId, reactionKey);
  const existing: Map<string, NostrEvent> =
    optimisticReactionEvents.get(cacheKey) || new Map();
  existing.set(reactionEvent.id, reactionEvent);
  optimisticReactionEvents.set(cacheKey, existing);
}

function forgetOptimisticReactions(
  eventId: string,
  reactionKey: string,
  reactionEventIds: string[],
): void {
  const cacheKey: string = getOptimisticReactionKey(eventId, reactionKey);
  const existing: Map<string, NostrEvent> | undefined =
    optimisticReactionEvents.get(cacheKey);
  if (!existing) {
    return;
  }
  reactionEventIds.forEach((reactionEventId: string): void => {
    existing.delete(reactionEventId);
  });
  if (existing.size === 0) {
    optimisticReactionEvents.delete(cacheKey);
  }
}

function rememberOptimisticRemovedReactions(
  eventId: string,
  reactionEventIds: string[],
): void {
  const existing: Set<string> =
    optimisticRemovedReactionEventIds.get(eventId) || new Set();
  reactionEventIds.forEach((reactionEventId: string): void => {
    existing.add(reactionEventId);
  });
  optimisticRemovedReactionEventIds.set(eventId, existing);
}

function forgetOptimisticRemovedReaction(
  eventId: string,
  reactionEventId: string,
): void {
  const existing: Set<string> | undefined =
    optimisticRemovedReactionEventIds.get(eventId);
  if (!existing) {
    return;
  }
  existing.delete(reactionEventId);
  if (existing.size === 0) {
    optimisticRemovedReactionEventIds.delete(eventId);
  }
}

function formatEventTimeLabel(createdAtSeconds: number): string {
  const nowSeconds: number = Math.floor(Date.now() / 1000);
  const diffSeconds: number = Math.max(0, nowSeconds - createdAtSeconds);
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 60 * 60) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 60 * 60 * 24)
    return `${Math.floor(diffSeconds / (60 * 60))}h ago`;
  if (diffSeconds < 60 * 60 * 24 * 7)
    return `${Math.floor(diffSeconds / (60 * 60 * 24))}d ago`;
  return new Date(createdAtSeconds * 1000).toLocaleDateString();
}

function hasTextSelectionWithin(container: HTMLElement): boolean {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const selectedText: string = selection.toString().trim();
  if (!selectedText) {
    return false;
  }

  const range: Range = selection.getRangeAt(0);
  return (
    container.contains(range.startContainer) ||
    container.contains(range.endContainer)
  );
}

async function fetchReactions(
  eventId: string,
  relays: string[],
): Promise<Map<string, ReactionAggregate>> {
  const cached: Promise<Map<string, ReactionAggregate>> | undefined =
    reactionCache.get(eventId);
  if (cached) {
    return cached;
  }

  const request: Promise<Map<string, ReactionAggregate>> = (async (): Promise<
    Map<string, ReactionAggregate>
  > => {
    const events: NostrEvent[] = await fetchReactionEvents(eventId, relays);
    const counts: Map<string, ReactionAggregate> = new Map();

    events.forEach((event: NostrEvent): void => {
      const reaction: ReactionAggregate = getReactionAggregate(
        event.content,
        event.tags,
      );
      const existing: ReactionAggregate | undefined = counts.get(reaction.key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(reaction.key, reaction);
      }
    });

    return counts;
  })();

  setCapped(reactionCache, eventId, request, MAX_REACTION_MEMO);
  return request;
}

async function fetchReactionEvents(
  eventId: string,
  relays: string[],
): Promise<NostrEvent[]> {
  const cached: Promise<NostrEvent[]> | undefined =
    reactionEventsCache.get(eventId);
  if (cached) {
    return cached;
  }

  const request: Promise<NostrEvent[]> = (async (): Promise<NostrEvent[]> => {
    const list: NostrEvent[] = await fetchAllReactions(eventId, relays);
    list.sort(
      (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
    );
    let kept: NostrEvent[] = list;
    try {
      const deletionEvents: NostrEvent[] = await fetchReactionDeletionEvents(
        list,
        relays,
      );
      kept = filterDeletedReactionEvents(list, deletionEvents);
    } catch (error: unknown) {
      console.warn('Failed to fetch reaction deletion events:', error);
    }
    return applyOptimisticReactionState(
      kept,
      getAllOptimisticReactionEvents(eventId),
      getOptimisticRemovedReactionIds(eventId),
    );
  })();

  setCapped(reactionEventsCache, eventId, request, MAX_REACTION_MEMO);
  return request;
}

/** Badges shown before the rest wait behind a pill: about two rows on a phone. */
const REACTIONS_SHOWN: number = 12;

/** One page of reactions; a relay commonly caps a page at about this. */
const REACTION_PAGE: number = 500;
/** A post with more than this many pages is a relay that will not stop. */
const MAX_REACTION_PAGES: number = 40;

/**
 * Every reaction to a post, page by page back in time, each relay on its own.
 *
 * A post can draw thousands, and one REQ returns a relay's page of them, so
 * the counts stopped at whatever the first page held. Each relay keeps its
 * own place - a shared one would jump past what a busier relay has not sent
 * yet. A page asks for what came at or before the oldest one seen, so
 * reactions sharing that second are not skipped, and repeats are dropped by
 * id. A page that brings nothing new ends the walk, unless it was full of
 * one second's reactions, in which case the next page starts a second
 * earlier.
 */
async function fetchAllReactions(
  eventId: string,
  relays: string[],
): Promise<NostrEvent[]> {
  const byId: Map<string, NostrEvent> = new Map();
  const walk = async (relay: string): Promise<void> => {
    let until: number | undefined;
    for (let page = 0; page < MAX_REACTION_PAGES; page += 1) {
      const got: NostrEvent[] = await queryRelays([relay], {
        kinds: [7],
        '#e': [eventId],
        limit: REACTION_PAGE,
        ...(until === undefined ? {} : { until }),
      });
      if (got.length === 0) return;
      let added: number = 0;
      let oldest: number = Number.POSITIVE_INFINITY;
      for (const event of got) {
        if (!byId.has(event.id)) {
          byId.set(event.id, event);
          added += 1;
        }
        if (event.created_at < oldest) oldest = event.created_at;
      }
      // A short page is the last one this relay has.
      if (got.length < REACTION_PAGE) return;
      // A full page of repeats is one second's worth: start a second earlier.
      until = added === 0 ? oldest - 1 : oldest;
    }
  };
  await Promise.allSettled(relays.map(walk));
  return Array.from(byId.values());
}

/**
 * Withdrawals of these reactions, asked about a few hundred at a time.
 *
 * A filter naming every id and every reactor of a busy post is one a relay
 * refuses, so each chunk names its own reactions and only their authors.
 */
async function fetchReactionDeletionEvents(
  reactions: NostrEvent[],
  relays: string[],
): Promise<NostrEvent[]> {
  const CHUNK: number = 200;
  const chunks: NostrEvent[][] = [];
  for (let index = 0; index < reactions.length; index += CHUNK) {
    chunks.push(reactions.slice(index, index + CHUNK));
  }
  const pages: NostrEvent[][] = await Promise.all(
    chunks.map(
      (chunk: NostrEvent[]): Promise<NostrEvent[]> =>
        queryRelays(relays, {
          kinds: [5],
          authors: Array.from(
            new Set(chunk.map((event: NostrEvent): string => event.pubkey)),
          ),
          '#e': chunk.map((event: NostrEvent): string => event.id),
          limit: Math.max(50, chunk.length * 2),
        }),
    ),
  );
  return pages.flat();
}

function resolveParentAuthorPubkey(event: NostrEvent): PubkeyHex | null {
  const pTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'p',
  );
  const replyTag: string[] | undefined = pTags.find(
    (tag: string[]): boolean => tag[3] === 'reply',
  );
  if (replyTag?.[1]) {
    return replyTag[1] as PubkeyHex;
  }
  const rootTag: string[] | undefined = pTags.find(
    (tag: string[]): boolean => tag[3] === 'root',
  );
  if (rootTag?.[1]) {
    return rootTag[1] as PubkeyHex;
  }
  return (pTags[0]?.[1] as PubkeyHex) || null;
}

export function getTagMarker(tag: string[]): string {
  return eTagMarker(tag);
}

function getTagRelayHints(tag: string[]): string[] {
  const relayHint: string = (tag[2] || '').trim();
  if (!relayHint) {
    return [];
  }
  const normalizedRelayHint: string | null = normalizeRelayUrl(relayHint);
  if (!normalizedRelayHint) {
    return [];
  }
  return [normalizedRelayHint];
}

function collectRelayHintsForParent(
  eTags: string[][],
  _parentEventId: string,
  primaryTag: string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  const addHintsFromTag = (tag: string[] | undefined): void => {
    if (!tag) return;
    for (const hint of getTagRelayHints(tag)) {
      if (!seen.has(hint)) {
        seen.add(hint);
        hints.push(hint);
      }
    }
  };

  addHintsFromTag(primaryTag);
  for (const tag of eTags) {
    addHintsFromTag(tag);
  }
  return hints;
}

function normalizeRelayList(relays: string[]): string[] {
  const seen = new Set<string>();
  const normalizedRelays: string[] = [];
  for (const relayUrl of relays) {
    const normalizedRelay: string | null = normalizeRelayUrl(relayUrl);
    if (!normalizedRelay || seen.has(normalizedRelay)) {
      continue;
    }
    seen.add(normalizedRelay);
    normalizedRelays.push(normalizedRelay);
  }
  return normalizedRelays;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchEventWithRetry(
  eventId: string,
  relays: string[],
  attempts: number = 5,
): Promise<NostrEvent | null> {
  for (let i = 0; i < attempts; i += 1) {
    const event: NostrEvent | null = await fetchReferencedEvent(
      eventId,
      relays,
      {
        bypassNullCache: i > 0,
        forceRefresh: i > 0,
      },
    );
    if (event) {
      return event;
    }
    if (i < attempts - 1) {
      await delay(700 + i * 900);
    }
  }
  rememberReferencedMiss(eventId);
  return null;
}

function closeReactionDetails(detailsContainer: HTMLElement): void {
  detailsContainer.style.display = 'none';
  delete detailsContainer.dataset.reaction;
  detailsContainer.innerHTML = '';
}

async function refreshReactionUi(
  eventId: string,
  eventCard: HTMLElement,
): Promise<void> {
  const reactionsContainer: HTMLElement | null = eventCard.querySelector(
    '.reactions-container',
  );
  const detailsContainer: HTMLElement | null =
    eventCard.querySelector('.reactions-details');

  if (detailsContainer) {
    closeReactionDetails(detailsContainer);
  }

  if (reactionsContainer) {
    await loadReactionsForEvent(eventId, reactionsContainer);
  }
}

export async function loadReactionsForEvent(
  eventId: string,
  container: HTMLElement,
): Promise<void> {
  const relays: string[] = getRelays();
  try {
    const counts: Map<string, ReactionAggregate> = await fetchReactions(
      eventId,
      relays,
    );
    if (counts.size === 0) {
      container.innerHTML = '';
      return;
    }

    const entries: ReactionAggregate[] = Array.from(counts.values());
    entries.sort(
      (a: ReactionAggregate, b: ReactionAggregate): number => b.count - a.count,
    );
    // Every kind of reaction, most given first. A busy post has more kinds
    // than fit above the fold, and the list of who gave one opens below the
    // last badge - so the rest wait behind a pill until asked for.
    container.innerHTML = '';
    const badges: HTMLElement[] = [];
    entries.forEach((reaction: ReactionAggregate): void => {
      const badge: HTMLSpanElement = document.createElement('span');
      badge.className =
        'relative inline-flex items-center gap-1 rounded-full bg-white border border-gray-200 px-2 py-1 cursor-pointer hover:bg-gray-50 transition-colors';
      badge.dataset.reaction = reaction.key;
      let emojiEl: HTMLSpanElement | HTMLImageElement;
      if (reaction.imageUrl && reaction.shortcode) {
        const imageEl: HTMLImageElement = document.createElement('img');
        imageEl.src = reaction.imageUrl;
        imageEl.alt = `:${reaction.shortcode}:`;
        imageEl.title = `:${reaction.shortcode}:`;
        imageEl.className = 'nox-emoji inline-block h-5 w-5 align-text-bottom';
        imageEl.loading = 'lazy';
        imageEl.decoding = 'async';
        emojiEl = imageEl;
      } else {
        const textEl: HTMLSpanElement = document.createElement('span');
        textEl.textContent = reaction.content;
        emojiEl = textEl;
      }
      const countEl: HTMLSpanElement = document.createElement('span');
      countEl.className = 'font-semibold text-gray-700';
      countEl.textContent = reaction.count.toString();
      badge.appendChild(emojiEl);
      badge.appendChild(countEl);
      if (!isReactionClickOnly()) {
        const tooltip: HTMLDivElement = document.createElement('div');
        tooltip.className =
          'fixed w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-2 text-xs text-gray-700 z-50';
        tooltip.style.display = 'none';
        document.body.appendChild(tooltip);

        let hoverTimeout: number | null = null;

        const positionTooltip = (): void => {
          const rect: DOMRect = badge.getBoundingClientRect();
          const spacing: number = 8;
          const top: number = rect.bottom + spacing;
          const left: number = Math.min(rect.left, window.innerWidth - 240);
          tooltip.style.top = `${top}px`;
          tooltip.style.left = `${Math.max(left, 8)}px`;
        };

        const showTooltip = (): void => {
          if (hoverTimeout) {
            window.clearTimeout(hoverTimeout);
            hoverTimeout = null;
          }
          positionTooltip();
          tooltip.style.display = 'block';
          loadReactionDetails(eventId, reaction.key, tooltip);
        };

        const hideTooltip = (): void => {
          if (hoverTimeout) {
            window.clearTimeout(hoverTimeout);
          }
          hoverTimeout = window.setTimeout((): void => {
            tooltip.style.display = 'none';
          }, 150);
        };

        badge.addEventListener('mouseenter', showTooltip);
        badge.addEventListener('mouseleave', hideTooltip);
        tooltip.addEventListener('mouseenter', showTooltip);
        tooltip.addEventListener('mouseleave', hideTooltip);

        window.addEventListener('scroll', () => {
          if (tooltip.style.display !== 'none') {
            positionTooltip();
          }
        });
      }

      badge.addEventListener('click', (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const eventCard: HTMLElement | null =
          container.closest('.event-container');
        const detailsContainer: HTMLElement | null = eventCard?.querySelector(
          '.reactions-details',
        ) as HTMLElement | null;
        if (!detailsContainer) {
          return;
        }

        const currentReactionKey: string | null =
          detailsContainer.style.display === 'none'
            ? null
            : detailsContainer.dataset.reaction || null;
        const nextState = getNextReactionDetailsState(
          currentReactionKey,
          reaction.key,
        );
        if (!nextState.isOpen || !nextState.reactionKey) {
          closeReactionDetails(detailsContainer);
          return;
        }

        detailsContainer.style.display = '';
        loadReactionDetails(eventId, nextState.reactionKey, detailsContainer);
        // Below every badge, which may be a long way down once all are shown.
        detailsContainer.scrollIntoView({
          block: 'nearest',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'auto'
            : 'smooth',
        });
      });
      container.appendChild(badge);
      badges.push(badge);
    });

    const hidden: HTMLElement[] = badges.slice(REACTIONS_SHOWN);
    if (hidden.length > 0) {
      const toggle: HTMLButtonElement = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nox-reactions-more';
      // Kept on the row, so redrawing it after a reaction leaves it open.
      const showAll = (all: boolean): void => {
        for (const badge of hidden) badge.hidden = !all;
        toggle.textContent = all ? 'Show fewer' : `+${hidden.length}`;
        toggle.setAttribute('aria-expanded', all ? 'true' : 'false');
        container.dataset.expanded = all ? 'true' : 'false';
      };
      toggle.addEventListener('click', (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        showAll(toggle.getAttribute('aria-expanded') !== 'true');
      });
      showAll(container.dataset.expanded === 'true');
      container.appendChild(toggle);
    }
  } catch (error: unknown) {
    console.warn('Failed to load reactions:', error);
  }
}

async function loadReactionDetails(
  eventId: string,
  reactionKey: string,
  container: HTMLElement,
): Promise<void> {
  container.dataset.reaction = reactionKey;
  container.innerHTML =
    '<div class="text-xs text-gray-500">Loading reactions...</div>';

  const relays: string[] = getRelays();
  try {
    const events: NostrEvent[] = await fetchReactionEvents(eventId, relays);
    const filtered: NostrEvent[] = events.filter(
      (event: NostrEvent): boolean =>
        getReactionAggregate(event.content, event.tags).key === reactionKey,
    );

    if (filtered.length === 0) {
      container.innerHTML =
        '<div class="text-xs text-gray-500">No reactions yet.</div>';
      return;
    }

    container.innerHTML = '';
    const list: HTMLDivElement = document.createElement('div');
    list.className = 'space-y-2 max-h-48 overflow-auto';
    container.appendChild(list);

    // One row per person, newest first, with how many times they gave this
    // one: a post asking for reactions gets the same person dozens of times.
    const times: Map<PubkeyHex, number> = new Map();
    for (const event of filtered) {
      const pubkey: PubkeyHex = event.pubkey as PubkeyHex;
      times.set(pubkey, (times.get(pubkey) ?? 0) + 1);
    }

    // Every row at once, with the name already known; the rest arrive below.
    const draw: Map<PubkeyHex, (profile: NostrProfile | null) => void> =
      new Map();
    for (const [pubkey, count] of times) {
      const npub: Npub = nip19.npubEncode(pubkey);
      const row: HTMLAnchorElement = document.createElement('a');
      row.className =
        'flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 transition-colors';
      row.href = `/${npub}`;
      const img: HTMLImageElement = document.createElement('img');
      img.className = 'w-6 h-6 rounded-full object-cover';
      const nameEl: HTMLSpanElement = document.createElement('span');
      row.append(img, nameEl);
      if (count > 1) {
        const countEl: HTMLSpanElement = document.createElement('span');
        countEl.className = 'text-xs text-gray-500';
        countEl.textContent = `×${count}`;
        row.appendChild(countEl);
      }
      const paint = (profile: NostrProfile | null): void => {
        const shown: NostrProfile | null = getAuthoritativeProfile(
          pubkey,
          profile,
        );
        const name: string = getDisplayName(npub, shown);
        setAvatar(img, pubkey, shown);
        img.alt = name;
        nameEl.textContent = name;
      };
      paint(null);
      draw.set(pubkey, paint);
      list.appendChild(row);
    }

    // A thousand reactors is a thousand profile lookups; eight at a time.
    const queue: PubkeyHex[] = Array.from(times.keys());
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          draw.get(next)?.(await fetchProfile(next, relays));
        } catch (error: unknown) {
          console.warn('Failed to load profile for reaction:', error);
        }
      }
    };
    await Promise.allSettled(Array.from({ length: 8 }, worker));
  } catch (error: unknown) {
    console.warn('Failed to load reaction details:', error);
    container.innerHTML =
      '<div class="text-xs text-gray-500">Failed to load reactions.</div>';
  }
}

async function publishReaction(
  eventId: string,
  targetPubkey: PubkeyHex,
  reaction: ReactionAggregate,
): Promise<NostrEvent | null> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    alert('Sign in to react.');
    return null;
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = withClientTag({
    kind: 7,
    pubkey: storedPubkey as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      ['p', targetPubkey],
    ],
    content: reaction.content,
  });
  if (reaction.shortcode && reaction.imageUrl) {
    unsignedEvent.tags.push(['emoji', reaction.shortcode, reaction.imageUrl]);
  }

  let signedEvent: NostrEvent;
  try {
    signedEvent = await signWithSession(unsignedEvent);
  } catch (error: unknown) {
    alert(error instanceof Error ? error.message : 'Sign in to react.');
    return null;
  }

  await publishEventToRelays(signedEvent, getRelays());
  return signedEvent;
}

/** Resolves true once the repost is signed and sent; false if it never was. */
async function publishRepost(targetEvent: NostrEvent): Promise<boolean> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    alert('Sign in to repost.');
    return false;
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = withClientTag({
    kind: 6,
    pubkey: storedPubkey as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: repostTags(targetEvent),
    content: JSON.stringify(targetEvent),
  });

  let signedEvent: NostrEvent;
  try {
    signedEvent = await signWithSession(unsignedEvent);
  } catch (error: unknown) {
    alert(error instanceof Error ? error.message : 'Sign in to repost.');
    return false;
  }

  await publishEventToRelays(signedEvent, getRelays());
  return true;
}

function renderReplyBadge(
  parentEventId: string,
  parentAuthorPubkey: PubkeyHex | null,
  container: HTMLElement,
): void {
  const parentPath = `/${nip19.neventEncode({ id: parentEventId })}`;

  if (parentAuthorPubkey) {
    const parentNpub = nip19.npubEncode(parentAuthorPubkey);
    const shortName = `@${parentNpub.slice(0, 12)}...`;
    container.innerHTML = `
      <div class="flex items-center gap-1 text-xs text-gray-500">
        <a href="${escapeHtml(parentPath)}" class="flex items-center gap-1 text-gray-400 hover:text-gray-600">
          <span>↩</span><span>replying to</span>
        </a>
        <a href="/${escapeHtml(parentNpub)}"
           class="reply-badge-username text-indigo-500 hover:underline font-medium"
           data-pubkey="${escapeHtml(parentAuthorPubkey)}">
          ${escapeHtml(shortName)}
        </a>
      </div>`;

    void fetchProfile(parentAuthorPubkey, getRelays()).then(
      (profile: NostrProfile | null): void => {
        const nameEl = container.querySelector('.reply-badge-username');
        if (nameEl) {
          const renderProfile: NostrProfile | null = getAuthoritativeProfile(
            parentAuthorPubkey,
            profile,
          );
          nameEl.textContent = `@${getDisplayName(parentNpub as Npub, renderProfile)}`;
        }
      },
    );
  } else {
    container.innerHTML = `
      <div class="flex items-center gap-1 text-xs text-gray-400">
        <a href="${escapeHtml(parentPath)}" class="flex items-center gap-1 hover:text-gray-600">
          <span>↩</span><span>reply</span>
        </a>
      </div>`;
  }
}

export function renderEvent(
  event: NostrEvent,
  profile: NostrProfile | null,
  npub: Npub,
  pubkey: PubkeyHex,
  output: HTMLElement,
): void {
  // Single choke point for muting: every timeline, the search page, profiles
  // and reply threads render through here, so one guard covers them all.
  if (isMuted(event.pubkey)) {
    return;
  }

  const renderProfile: NostrProfile | null = getAuthoritativeProfile(
    pubkey,
    profile,
  );
  const isRepost: boolean = event.kind === 6 || event.kind === 16;

  // Data, not words. Judged on what would be shown: a plain note on its own
  // content, a repost on its verified embedded copy. A repost with no such
  // copy is not judged here - its content is the serialised target and the
  // repost path below fetches the real thing.
  const judged: NostrEvent | null = isRepost
    ? unwrapRepost(event).event
    : event;
  if (judged && isMachineContent(judged.content)) {
    return;
  }

  const repostEventId: string | null = isRepost
    ? resolveRepostEventId(event)
    : null;
  const avatar: string = getAvatarURL(pubkey, renderProfile);
  const name: string = getDisplayName(npub, renderProfile);
  const safeName: string = escapeHtml(name);
  const safeNpub: string = escapeHtml(npub);
  const createdAt: string = new Date(event.created_at * 1000).toLocaleString();
  const timeLabel: string = formatEventTimeLabel(event.created_at);

  // Beside the timestamp, in the same size and the same grey: which client
  // someone posted from is the kind of thing you look for, not the kind of
  // thing that should catch your eye. Absent when the event does not say.
  const clientName: string | null = readClientName(event.tags);
  const clientNameHtml: string = clientName
    ? `<span class="flex-none text-xs text-gray-500" title="Posted with ${escapeHtml(clientName)}">\u00b7 ${escapeHtml(clientName)}</span>`
    : '';
  let eventPermalink: string | null = null;
  try {
    eventPermalink = `/${nip19.neventEncode({ id: event.id })}`;
  } catch (e) {
    console.warn('Failed to encode nevent for event link:', e);
    eventPermalink = null;
  }
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  // A pubkey alone is not permission: browsing as a key draws the row too,
  // with every write in it disabled and saying why.
  const isLoggedIn: boolean = Boolean(storedPubkey) && canWrite();
  const canDeletePost: boolean = Boolean(
    isLoggedIn && storedPubkey === event.pubkey,
  );
  // Moderation applies to other people's posts; muting yourself is meaningless
  // and reporting yourself is noise for relay operators.
  const canModerate: boolean = Boolean(
    isLoggedIn && storedPubkey !== event.pubkey,
  );
  const canZapTarget: boolean = Boolean(
    isLoggedIn && (renderProfile?.lud16 || renderProfile?.lud06),
  );
  const actionBtnBase: string =
    'event-action-btn inline-flex items-center justify-center rounded transition-colors';
  const actionBtnDisabled: string = 'opacity-60 cursor-not-allowed';

  const replyButtonTitle: string = isLoggedIn
    ? 'Reply'
    : 'Reply (sign-in required)';
  const actionIdle: string = 'text-slate-400';
  const replyButtonClasses: string = isLoggedIn
    ? `${actionBtnBase} reply-event-btn ${actionIdle} hover:text-blue-500 hover:bg-blue-50`
    : `${actionBtnBase} reply-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const repostButtonTitle: string = isLoggedIn
    ? 'Repost'
    : 'Repost (sign-in required)';
  const repostButtonClasses: string = isLoggedIn
    ? `${actionBtnBase} repost-event-btn ${actionIdle} hover:text-emerald-500 hover:bg-emerald-50`
    : `${actionBtnBase} repost-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const reactButtonTitle: string = isLoggedIn
    ? 'React'
    : 'React (sign-in required)';
  const reactButtonClasses: string = isLoggedIn
    ? `${actionBtnBase} react-event-btn ${actionIdle} hover:text-rose-500 hover:bg-rose-50`
    : `${actionBtnBase} react-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const zapButtonTitle: string = canZapTarget
    ? 'Zap via Lightning'
    : 'Zap unavailable';
  const zapButtonClasses: string = canZapTarget
    ? `${actionBtnBase} zap-event-btn ${actionIdle} hover:text-amber-500 hover:bg-amber-50`
    : `${actionBtnBase} zap-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const _deleteButtonTitle: string = 'Delete post';
  const moderationBtnClasses: string = `${actionBtnBase} text-gray-400 hover:text-gray-600 hover:bg-gray-100`;
  // The mark opens the menu that holds mute, report and delete. Muting and
  // reporting are for other people's posts and deleting is for your own, so
  // a mark shown only for the first left your own posts with no way to ask
  // for a deletion at all.
  const hasMoreActions: boolean = canModerate || canDeletePost;

  const actionBarHtml: string = `
          <div class="event-actions flex items-center">
            <button class="${replyButtonClasses}" aria-label="Reply to post" title="${replyButtonTitle}" data-event-id="${escapeHtml(event.id)}" data-event-pubkey="${escapeHtml(event.pubkey)}" data-event-author="${safeName}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.77 9.77 0 01-3.18-.52L3 20l1.35-3.6A7.76 7.76 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01" />
              </svg>
            </button>
            <button class="${repostButtonClasses}" aria-label="Repost" title="${repostButtonTitle}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h10l-2-2m2 2l-2 2" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M17 17H7l2 2m-2-2l2-2" />
              </svg>
            </button>
            <button class="${reactButtonClasses}" aria-label="React" title="${reactButtonTitle}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
              </svg>
            </button>
            ${
              canZapTarget
                ? `<button class="${zapButtonClasses}" aria-label="Zap post" title="${zapButtonTitle}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M13 2L4 14h7l-1 8 10-12h-7l1-8z" />
                    </svg>
                  </button>`
                : ''
            }
            ${
              hasMoreActions
                ? `<button class="${moderationBtnClasses} more-actions-btn" aria-label="More actions" title="More actions" aria-haspopup="menu">
                    <svg viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 block" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="19" cy="12" r="1.6" />
                    </svg>
                  </button>`
                : ''
            }
          </div>
        `;

  const contentSource: string = isRepost ? '' : event.content;
  const contentWarning: ContentWarning = getContentWarning(event);
  const parentReference: ParentReference | null = isRepost
    ? null
    : resolveParentReference(event);
  const parentEventId: string | null = parentReference?.eventId || null;
  const parentAuthorPubkey: PubkeyHex | null = parentEventId
    ? resolveParentAuthorPubkey(event)
    : null;
  const isEnergySavingMode: boolean =
    localStorage.getItem('energy_saving_mode') === 'true';

  // The links, pictures, mentions, quotes and emoji are found once, by the
  // parser the phone uses too; what is left to do here is draw the card.
  const rendered: RenderedContent = renderContentHtml(
    contentSource,
    event.tags,
    { energySaving: isEnergySavingMode },
  );
  const urls: string[] = rendered.links;
  const imageUrls: string[] = rendered.images;
  const mentionNpubToPubkey: Map<string, PubkeyHex> = rendered.mentions;
  const referencedEventRefs: string[] = rendered.quotes;
  const contentWithCustomEmoji: string = rendered.html;
  const hasContent: boolean = contentWithCustomEmoji.trim().length > 0;
  const repostBadgeHtml: string = isRepost
    ? `<span class="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs font-semibold px-2 py-0.5">🔁 Repost</span>`
    : '';
  const contentHtml: string = hasContent
    ? `<div class="nox-post-text whitespace-pre-wrap break-words mb-2 text-sm text-gray-700">${contentWithCustomEmoji}</div>`
    : '';
  const contentAreaHtml: string = contentWarning.hasWarning
    ? `
      <details class="event-cw-details mb-2 rounded-lg border border-amber-300 bg-amber-50">
        <summary class="cursor-pointer select-none text-xs font-semibold text-amber-900 px-3 py-2">
          ⚠️ ${escapeHtml(contentWarningSummary(contentWarning))}. Click to reveal.
        </summary>
        <div class="px-3 pb-3 pt-2">
          ${
            contentHtml ||
            '<div class="mb-2 text-xs text-gray-600">(Content hidden)</div>'
          }
          <div class="referenced-events-container space-y-2"></div>
          <div class="ogp-container"></div>
        </div>
      </details>
    `
    : `
      ${contentHtml}
      <div class="referenced-events-container space-y-2"></div>
      <div class="ogp-container"></div>
    `;

  const div: HTMLDivElement = document.createElement('div');
  div.className =
    'bg-gray-50 border border-gray-200 rounded p-4 shadow event-container cursor-pointer hover:bg-gray-100/60 transition-colors';
  // Used by timelines to keep DOM ordering stable without re-rendering.
  div.dataset.eventId = event.id;
  div.dataset.createdAt = String(event.created_at);
  div.dataset.pubkey = pubkey;
  div.dataset.timestamp = event.created_at.toString();
  div.dataset.reply = parentEventId ? 'true' : 'false';
  if (imageUrls.length > 0) {
    div.dataset.images = JSON.stringify(imageUrls);
  }
  // Avatar display based on energy saving mode
  const safeAvatar: string =
    loadableOnThisPage(avatar) ?? fallbackAvatarUrl(pubkey);
  const avatarHtml: string = isEnergySavingMode
    ? `<div class="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-xl">👤</div>`
    : `<img src="${escapeHtml(safeAvatar)}" alt="Avatar" class="event-avatar w-12 h-12 rounded-full object-cover cursor-pointer"
         onerror="${avatarErrorAttribute(pubkey)}" />`;

  div.innerHTML = `
					    <div class="flex items-start space-x-4">
				      <a href="/${safeNpub}" class="flex-shrink-0 hover:opacity-80 transition-opacity">
				        ${avatarHtml}
				      </a>
				      <div class="flex-1 overflow-x-hidden overflow-y-visible">
			        <div class="flex items-center gap-2 min-w-0 mb-1">
			          <a href="/${safeNpub}" class="event-username min-w-0 truncate font-semibold text-gray-800 text-sm hover:text-blue-600 transition-colors">${safeName}</a>
				          <span class="event-nip05 min-w-0 truncate text-xs text-gray-500"></span>
			          ${
                  eventPermalink
                    ? `<a href="${eventPermalink}" class="flex-none text-xs text-gray-500 hover:text-blue-600 transition-colors" title="${escapeHtml(createdAt)}">${escapeHtml(timeLabel)}</a>`
                    : `<span class="flex-none text-xs text-gray-500" title="${escapeHtml(createdAt)}">${escapeHtml(timeLabel)}</span>`
                }
			          ${clientNameHtml}
			        </div>
			        <p class="event-status hidden text-xs text-gray-500 mb-1 truncate"></p>
		        ${repostBadgeHtml}
              ${eventPermalink ? `<a class="event-permalink" href="${eventPermalink}" aria-hidden="true" tabindex="-1" style="display:none;"></a>` : ''}
		            <div class="reply-badge-container mb-1.5"></div>
                  ${contentAreaHtml}
		            <div class="reactions-container mt-2 flex flex-wrap gap-2 text-xs text-gray-600"></div>
		            <div class="reactions-details mt-2" style="display: none;"></div>
		            <div class="mt-2 flex items-center justify-between gap-2">
		              ${actionBarHtml}
		            </div>
				      </div>
				    </div>
				  `;

  // The address beside the name is drawn empty and filled in only once the
  // domain has confirmed it is this person's: a claimed address is the one
  // string on a card that must not be taken on trust. After the markup, so
  // the slot exists to fill.
  void showVerifiedNip05(div, pubkey as PubkeyHex, renderProfile);

  // Newest first. Cached and batched renders already arrive in order, so
  // nearly every card is older than the last one drawn: that is checked
  // before the list is walked, or a long timeline costs a walk per card.
  const newerThan = (card: HTMLElement): boolean =>
    event.created_at > parseInt(card.dataset.timestamp || '0', 10);
  const lastChild: Element | null = output.lastElementChild;
  const lastCard: HTMLElement | null =
    lastChild instanceof HTMLElement &&
    lastChild.classList.contains('event-container')
      ? lastChild
      : null;
  const before: HTMLElement | undefined =
    lastCard && !newerThan(lastCard)
      ? undefined
      : Array.from(
          output.querySelectorAll<HTMLElement>('.event-container'),
        ).find(newerThan);
  if (before) {
    output.insertBefore(div, before);
  } else {
    output.appendChild(div);
  }
  if (parentEventId) {
    const parentContainer: HTMLElement | null = div.querySelector(
      '.reply-badge-container',
    );
    if (parentContainer) {
      renderReplyBadge(parentEventId, parentAuthorPubkey, parentContainer);
    }
  }
  if (mentionNpubToPubkey.size > 0) {
    enrichMentionDisplayNames(div, mentionNpubToPubkey);
  }

  const replyButton: HTMLButtonElement | null = div.querySelector(
    '.reply-event-btn',
  ) as HTMLButtonElement | null;
  if (replyButton) {
    replyButton.addEventListener('click', (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (!isLoggedIn) {
        alert('Sign in to reply.');
        return;
      }
      // Trigger reply overlay via custom event
      const replyEvent = new CustomEvent('open-reply', {
        detail: {
          // The whole event: the overlay needs its tags to place the reply in
          // the thread, which an id and a pubkey cannot tell it.
          event,
          eventAuthor: name,
          eventContent: contentSource,
        },
      });
      window.dispatchEvent(replyEvent);
    });
  }

  const moreButton: HTMLButtonElement | null = div.querySelector(
    '.more-actions-btn',
  ) as HTMLButtonElement | null;
  if (moreButton) {
    moreButton.addEventListener('click', (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // Mute and report are rare and consequential. Behind one control they
      // stop competing with reply and zap for attention, and a stray tap can
      // no longer mute someone outright.
      window.dispatchEvent(
        new CustomEvent('request-post-actions', {
          detail: {
            pubkey: event.pubkey,
            eventId: event.id,
            name,
            // Passed as a function rather than a flag: the card owns the
            // cleanup that follows a deletion, and the menu only decides
            // whether it was asked for.
            onDelete: canDeletePost ? runDelete : undefined,
          },
        }),
      );
    });
  }

  const repostButton: HTMLButtonElement | null = div.querySelector(
    '.repost-event-btn',
  ) as HTMLButtonElement | null;
  if (repostButton) {
    repostButton.addEventListener(
      'click',
      async (e: MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        if (!isLoggedIn) {
          alert('Sign in to repost.');
          return;
        }
        repostButton.disabled = true;
        repostButton.classList.add('opacity-60', 'cursor-not-allowed');
        try {
          if (await publishRepost(event)) {
            recordOwnReaction(
              storedPubkey as PubkeyHex,
              event.id,
              'repost',
              true,
            );
          }
        } catch (error: unknown) {
          console.error('Failed to repost:', error);
          alert('Failed to repost. Please try again.');
        } finally {
          repostButton.disabled = false;
          repostButton.classList.remove('opacity-60', 'cursor-not-allowed');
        }
      },
    );
  }

  const reactButton: HTMLButtonElement | null = div.querySelector(
    '.react-event-btn',
  ) as HTMLButtonElement | null;
  if (reactButton) {
    reactButton.addEventListener(
      'click',
      async (e: MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        if (!isLoggedIn) {
          alert('Sign in to react.');
          return;
        }
        const reaction: ReactionAggregate = {
          count: 1,
          key: 'text:❤',
          content: '❤',
        };
        reactButton.disabled = true;
        reactButton.classList.add('opacity-60', 'cursor-not-allowed');
        try {
          const viewerPubkey: PubkeyHex = storedPubkey as PubkeyHex;
          const relayReactionEvents: NostrEvent[] = await fetchReactionEvents(
            event.id,
            getRelays(),
          );
          const reactionEvents: NostrEvent[] = mergeReactionEvents(
            relayReactionEvents,
            getOptimisticReactionEvents(event.id, reaction.key),
          );
          // Whatever filled the heart is what unliking takes back: every
          // reaction of yours on this post, not only a ❤.
          const existingHeartReactions: NostrEvent[] = findOwnReactionEvents(
            reactionEvents,
            viewerPubkey,
            event.id,
          );

          if (existingHeartReactions.length > 0) {
            rememberOptimisticRemovedReactions(
              event.id,
              existingHeartReactions.map(
                (reactionEvent: NostrEvent): string => reactionEvent.id,
              ),
            );
            await Promise.allSettled(
              existingHeartReactions.map(
                async (reactionEvent: NostrEvent): Promise<void> => {
                  await requestDeletion(reactionEvent, getRelays());
                },
              ),
            );
            await deleteEvents(
              existingHeartReactions.map(
                (reactionEvent: NostrEvent): string => reactionEvent.id,
              ),
            );
            for (const removed of existingHeartReactions) {
              forgetOptimisticReactions(
                event.id,
                getReactionAggregate(removed.content, removed.tags).key,
                [removed.id],
              );
            }
            recordOwnReaction(viewerPubkey, event.id, 'like', false);
          } else {
            const publishedReaction: NostrEvent | null = await publishReaction(
              event.id,
              event.pubkey,
              reaction,
            );
            if (publishedReaction) {
              rememberOptimisticReaction(
                event.id,
                reaction.key,
                publishedReaction,
              );
              forgetOptimisticRemovedReaction(event.id, publishedReaction.id);
              recordOwnReaction(viewerPubkey, event.id, 'like', true);
            }
          }

          invalidateReactionCaches(event.id);
          await refreshReactionUi(event.id, div);
        } catch (error: unknown) {
          console.error('Failed to react:', error);
          alert('Failed to react. Please try again.');
        } finally {
          reactButton.disabled = false;
          reactButton.classList.remove('opacity-60', 'cursor-not-allowed');
        }
      },
    );
  }

  // Whether this viewer already liked or reposted it is asked once for all
  // the cards of this render, and painted onto the ♡ and ⇄ when known.
  noteRenderedCard(div, event.id);

  const zapButton: HTMLButtonElement | null = div.querySelector(
    '.zap-event-btn',
  ) as HTMLButtonElement | null;
  if (zapButton) {
    zapButton.addEventListener('click', (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      openZapComposer({
        targetType: 'event',
        recipientPubkey: event.pubkey as PubkeyHex,
        recipientName: name,
        recipientProfile: profile,
        event,
      });
    });
  }

  /**
   * Deleting, for the overflow menu to call.
   *
   * It used to be a bin icon of its own, sitting beside reply and repost - a
   * destructive, irreversible action one stray tap away from the two things
   * people press most. It is behind the same menu as mute and report now,
   * which is where the rare and consequential things live.
   */
  const runDelete = async (): Promise<void> => {
    await requestDeletion(event, getRelays());
    cacheDeletionStatus(event.id, true);
    const viewerPubkey: PubkeyHex | null =
      (localStorage.getItem('nostr_pubkey') as PubkeyHex | null) || null;
    const targets = computeTimelineRemovalTargets({
      viewerPubkey,
      authorPubkey: event.pubkey as PubkeyHex,
    });
    await deleteEvents([event.id]);
    await Promise.allSettled(
      targets.map(async (target) => {
        if (target.type === 'global') {
          await removeEventFromTimeline('global', undefined, event.id);
        } else if (target.type === 'home') {
          await removeEventFromTimeline('home', target.pubkey, event.id);
        } else {
          await removeEventFromTimeline('user', target.pubkey, event.id);
        }
      }),
    );
    div.remove();
  };

  // Click anywhere on the card (except interactive elements) to navigate to the event page.
  if (eventPermalink) {
    div.addEventListener('click', (e: MouseEvent): void => {
      const target: HTMLElement | null = e.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (
        target.closest('a') ||
        target.closest('button') ||
        target.closest('summary') ||
        target.closest('details') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('select') ||
        // Images open the gallery. That listener sits on the document, so it
        // runs after this one and cannot call the click off - the exclusion
        // has to happen here or the post opens out from under the overlay.
        target.closest('.event-image') ||
        target.closest('.event-video') ||
        target.closest('.reactions-container') ||
        target.closest('.reactions-details')
      ) {
        return;
      }
      if (hasTextSelectionWithin(div)) {
        return;
      }
      const permalinkAnchor: HTMLAnchorElement | null = div.querySelector(
        '.event-permalink',
      ) as HTMLAnchorElement | null;
      if (permalinkAnchor) {
        permalinkAnchor.click();
      }
    });
  }

  // Skip OGP/embeds in energy saving mode
  if (urls.length > 0 && !isEnergySavingMode) {
    const ogpContainer: HTMLElement | null =
      div.querySelector('.ogp-container');
    if (ogpContainer) {
      urls.forEach(async (url: string): Promise<void> => {
        if (isTwitterURL(url)) {
          renderTwitterEmbed(url, ogpContainer);
        } else {
          const ogpData: OGPResponse | null = await fetchOGP(url);
          if (ogpData?.data) {
            renderOGPCard(ogpData, ogpContainer);
          }
        }
      });
    }
  }

  const allReferencedEventRefs: string[] = [...referencedEventRefs];
  if (repostEventId) {
    try {
      const repostRef: string = nip19.neventEncode({ id: repostEventId });
      if (!allReferencedEventRefs.includes(repostRef)) {
        allReferencedEventRefs.unshift(repostRef);
      }
    } catch (e) {
      console.warn('Failed to encode repost event ref:', e);
    }
  }

  if (allReferencedEventRefs.length > 0) {
    const referencedContainer: HTMLElement | null = div.querySelector(
      '.referenced-events-container',
    );
    if (referencedContainer) {
      renderReferencedEventCards(allReferencedEventRefs, referencedContainer);
    }
  }
}

/** The event id an nevent/note reference names, or '' when it will not decode. */
function referencedIdOf(eventRef: string): string {
  try {
    const decoded = nip19.decode(eventRef);
    if (decoded.type === 'note') return decoded.data as string;
    if (decoded.type === 'nevent') return (decoded.data as { id: string }).id;
  } catch {
    // Not a reference this reads.
  }
  return '';
}

/**
 * Fills a card's address slot with the profile's NIP-05, once verified.
 *
 * Safe to call again when a fuller profile arrives: the slot is cleared
 * first, and a stale answer for a card that has since been re-rendered
 * lands on nothing.
 */
export async function showVerifiedNip05(
  card: HTMLElement,
  pubkey: PubkeyHex,
  profile: NostrProfile | null,
): Promise<void> {
  const slot: HTMLElement | null = card.querySelector('.event-nip05');
  if (!slot) return;
  slot.textContent = '';
  const address: string | null = await verifiedNip05(pubkey, profile?.nip05);
  if (!address) return;
  const name: string =
    card.querySelector('.event-username')?.textContent?.trim() ?? '';
  slot.textContent = address === name ? '' : address;
}

function resolveRepostEventId(event: NostrEvent): string | null {
  if (event.kind !== 6 && event.kind !== 16) {
    return null;
  }
  if (event.content) {
    try {
      const parsed: { id?: string } = JSON.parse(event.content);
      if (parsed && typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {
      // ignore non-JSON content
    }
  }
  const eTag: string[] | undefined = event.tags.find(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  return eTag?.[1] || null;
}

function resolveParentReference(event: NostrEvent): ParentReference | null {
  const eTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  if (eTags.length === 0) {
    return null;
  }

  const replyTag: string[] | undefined = eTags.find(
    (tag: string[]): boolean => getTagMarker(tag) === 'reply',
  );
  if (replyTag?.[1]) {
    return {
      eventId: replyTag[1],
      relayHints: collectRelayHintsForParent(eTags, replyTag[1], replyTag),
    };
  }

  const rootTag: string[] | undefined = eTags.find(
    (tag: string[]): boolean => getTagMarker(tag) === 'root',
  );
  if (rootTag?.[1]) {
    return {
      eventId: rootTag[1],
      relayHints: collectRelayHintsForParent(eTags, rootTag[1], rootTag),
    };
  }

  const legacyParentTags: string[][] = eTags.filter(
    (tag: string[]): boolean => getTagMarker(tag) === '',
  );
  const fallbackTag: string[] | undefined =
    legacyParentTags[legacyParentTags.length - 1];
  if (fallbackTag?.[1]) {
    return {
      eventId: fallbackTag[1],
      relayHints: collectRelayHintsForParent(
        legacyParentTags,
        fallbackTag[1],
        fallbackTag,
      ),
    };
  }

  return null;
}

function checkDeletionAsync(
  eventId: string,
  authorPubkey: PubkeyHex,
  relays: string[],
  cardElement: HTMLElement,
  deletedMessage: string,
): void {
  const cachedStatus: boolean | undefined = getCachedDeletionStatus(eventId);
  if (cachedStatus !== undefined) {
    return;
  }

  void isEventDeleted(eventId, authorPubkey, relays)
    .then((deleted: boolean): void => {
      cacheDeletionStatus(eventId, deleted);
      if (deleted) {
        const viewerPubkey: PubkeyHex | null =
          (localStorage.getItem('nostr_pubkey') as PubkeyHex | null) || null;
        const targets = computeTimelineRemovalTargets({
          viewerPubkey,
          authorPubkey,
        });
        void deleteEvents([eventId]);
        targets.forEach((target) => {
          if (target.type === 'global') {
            void removeEventFromTimeline('global', undefined, eventId);
          } else if (target.type === 'home') {
            void removeEventFromTimeline('home', target.pubkey, eventId);
          } else {
            void removeEventFromTimeline('user', target.pubkey, eventId);
          }
        });
        cardElement.textContent = deletedMessage;
      }
    })
    .catch((err: unknown): void => {
      console.warn(`Failed to check deletion status for ${eventId}:`, err);
      cacheDeletionStatus(eventId, false);
    });
}

async function enrichMentionDisplayNames(
  eventContainer: HTMLElement,
  mentionNpubToPubkey: Map<string, PubkeyHex>,
): Promise<void> {
  const relays: string[] = getRelays();

  for (const [mentionedRef, mentionedPubkey] of mentionNpubToPubkey.entries()) {
    try {
      const mentionedProfile: NostrProfile | null = await fetchProfile(
        mentionedPubkey,
        relays,
      );
      const renderProfile: NostrProfile | null = getAuthoritativeProfile(
        mentionedPubkey,
        mentionedProfile,
      );
      const mentionedNpub: Npub = nip19.npubEncode(mentionedPubkey);
      const displayName: string = getDisplayName(mentionedNpub, renderProfile);

      // Handle both npub and nprofile mentions
      const npubAnchors: NodeListOf<HTMLAnchorElement> =
        eventContainer.querySelectorAll(
          `a.mention-link[data-mention-npub="${mentionedRef}"]`,
        );
      const nprofileAnchors: NodeListOf<HTMLAnchorElement> =
        eventContainer.querySelectorAll(
          `a.mention-link[data-mention-nprofile="${mentionedRef}"]`,
        );

      npubAnchors.forEach((anchor: HTMLAnchorElement): void => {
        anchor.textContent = `@${displayName}`;
      });
      nprofileAnchors.forEach((anchor: HTMLAnchorElement): void => {
        anchor.textContent = `@${displayName}`;
      });
    } catch (error: unknown) {
      console.warn('Failed to resolve mentioned profile:', error);
    }
  }
}

async function renderReferencedEventCards(
  eventRefs: string[],
  container: HTMLElement,
): Promise<void> {
  const currentRelays: string[] = normalizeRelayList(getRelays());
  const maxCards: number = 3;
  // Notes the page itself is showing, marked on the output by the event
  // page. A quote of one of them is a pointer at something already here.
  const shown: Set<string> = new Set(
    (
      container.closest<HTMLElement>('[data-thread-ids]')?.dataset.threadIds ??
      ''
    )
      .split(',')
      .filter(Boolean),
  );

  // Excluded before the cap, not after: a note quoting three things on
  // this page and one elsewhere should still show the one elsewhere.
  const worthACard: string[] = eventRefs.filter(
    (eventRef: string): boolean => !shown.has(referencedIdOf(eventRef)),
  );

  for (const eventRef of worthACard.slice(0, maxCards)) {
    const card: HTMLDivElement = document.createElement('div');
    card.className = 'border border-indigo-200 bg-indigo-50 rounded-lg p-3';
    // Named, so a page that later shows this note in full can take the
    // card back.
    card.dataset.referencedId = referencedIdOf(eventRef);
    card.textContent = 'Loading referenced event...';
    container.appendChild(card);

    try {
      const decoded = nip19.decode(eventRef);
      let eventId: string | undefined;
      let relayHints: string[] = [];
      let referencedAuthorPubkey: PubkeyHex | null = null;
      if (decoded.type === 'nevent') {
        const data: any = decoded.data;
        eventId = data?.id || (typeof data === 'string' ? data : undefined);
        relayHints = Array.isArray(data?.relays)
          ? normalizeRelayList(
              data.relays.filter(
                (value: unknown): value is string => typeof value === 'string',
              ),
            )
          : [];
        if (data?.author && typeof data.author === 'string') {
          referencedAuthorPubkey = data.author as PubkeyHex;
        }
      } else if (decoded.type === 'note') {
        eventId = typeof decoded.data === 'string' ? decoded.data : undefined;
      } else {
        card.textContent = 'Referenced event is invalid.';
        continue;
      }

      if (!eventId) {
        card.textContent = 'Referenced event ID is missing.';
        continue;
      }

      const relaysToUse: string[] = normalizeRelayList([
        ...relayHints,
        ...currentRelays,
      ]);
      if (relaysToUse.length === 0) {
        card.textContent = 'No relays available for referenced event.';
        continue;
      }
      if (referencedAuthorPubkey) {
        const cachedStatus: boolean | undefined =
          getCachedDeletionStatus(eventId);
        if (cachedStatus === true) {
          card.textContent = 'Referenced event was deleted.';
          continue;
        }
        if (cachedStatus === undefined) {
          checkDeletionAsync(
            eventId,
            referencedAuthorPubkey,
            relaysToUse,
            card,
            'Referenced event was deleted.',
          );
        }
      }

      const fetchedReference: NostrEvent | null = await fetchEventWithRetry(
        eventId,
        relaysToUse,
        5,
      );
      if (!fetchedReference) {
        card.textContent = 'Failed to load referenced event.';
        continue;
      }

      // A quoted repost shows the note it reposted, never its own content,
      // which is that note as JSON. With no verified copy the target is
      // fetched by id.
      let referencedEvent: NostrEvent | null = fetchedReference;
      const unwrappedReference = unwrapRepost(fetchedReference);
      if (unwrappedReference.repostedBy) {
        referencedEvent =
          unwrappedReference.event ??
          (unwrappedReference.targetId
            ? await fetchEventWithRetry(
                unwrappedReference.targetId,
                relaysToUse,
                5,
              )
            : null);
      }
      if (!referencedEvent) {
        card.textContent = 'Failed to load referenced event.';
        continue;
      }
      // Data, not words. This path is reached by fetching, so the guard at
      // the top of renderEvent never saw it - the same rule applies here.
      if (isMachineContent(referencedEvent.content)) {
        card.textContent = 'Quoted note contains no readable text.';
        continue;
      }

      const referencedProfile: NostrProfile | null = await fetchProfile(
        referencedEvent.pubkey,
        relaysToUse,
      );
      const renderProfile: NostrProfile | null = getAuthoritativeProfile(
        referencedEvent.pubkey as PubkeyHex,
        referencedProfile,
      );
      const referencedNpub: Npub = nip19.npubEncode(referencedEvent.pubkey);
      const referencedName: string = getDisplayName(
        referencedNpub,
        renderProfile,
      );
      const referencedAvatar: string = getAvatarURL(
        referencedEvent.pubkey,
        renderProfile,
      );
      const referencedContent: string = renderEmojiHtml(
        referencedEvent.content,
        referencedEvent.tags,
      );
      const referencedContentWarning: ContentWarning =
        getContentWarning(referencedEvent);
      const referencedText: string =
        referencedContent.length > 180
          ? `${referencedContent.slice(0, 180)}...`
          : referencedContent;
      const referencedPath: string = `/${eventRef}`;
      const safeReferencedPath: string = escapeHtml(referencedPath);
      const safeReferencedName: string = escapeHtml(referencedName);

      const isEnergySavingMode: boolean =
        localStorage.getItem('energy_saving_mode') === 'true';
      const safeReferencedAvatar: string =
        loadableOnThisPage(referencedAvatar) ??
        fallbackAvatarUrl(referencedEvent.pubkey);
      const referencedAvatarHtml: string = isEnergySavingMode
        ? `<div class="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-sm flex-shrink-0">👤</div>`
        : `<img
            src="${escapeHtml(safeReferencedAvatar)}"
            alt="${safeReferencedName}"
            class="w-8 h-8 rounded-full object-cover flex-shrink-0"
            onerror="${avatarErrorAttribute(referencedEvent.pubkey)}"
          />`;

      const referencedPreviewHtml: string = referencedContentWarning.hasWarning
        ? `<div class="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">⚠️ ${escapeHtml(contentWarningSummary(referencedContentWarning))}. Open post to view.</div>`
        : `<div class="nox-post-text text-sm text-gray-800 whitespace-pre-wrap break-words">${referencedText || '(no content)'}</div>`;

      card.innerHTML = `
                <a href="${safeReferencedPath}" class="block hover:bg-indigo-100 rounded transition-colors p-1">
                    <div class="flex items-start gap-2">
                        ${referencedAvatarHtml}
                        <div class="min-w-0">
                            <div class="text-xs text-gray-700 font-semibold mb-1 truncate">${safeReferencedName}</div>
                            ${referencedPreviewHtml}
                        </div>
                    </div>
                </a>
            `;
    } catch (error: unknown) {
      console.warn('Failed to render referenced event card:', error);
      card.textContent = 'Failed to load referenced event.';
    }
  }
}

function renderOGPCard(ogpData: OGPResponse, container: HTMLElement): void {
  // What the card says is decided by the shared describer, so the phone's
  // card and this one agree about the same page.
  const described: LinkCard | null = describeLink(ogpData);
  if (!described) {
    return;
  }
  const { url, title, description, image } = described;
  const siteName: string = described.site;

  const card: HTMLDivElement = document.createElement('div');
  card.className =
    'border border-gray-300 rounded-lg overflow-hidden my-2 hover:shadow-md transition-shadow bg-white';
  const link: HTMLAnchorElement = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'block no-underline';

  if (image) {
    const imageEl: HTMLImageElement = document.createElement('img');
    imageEl.src = image;
    imageEl.alt = title;
    imageEl.className = 'w-full h-48 object-cover';
    imageEl.loading = 'lazy';
    imageEl.onerror = (): void => {
      imageEl.style.display = 'none';
    };
    link.appendChild(imageEl);
  }

  const body: HTMLDivElement = document.createElement('div');
  body.className = 'p-3';

  if (siteName) {
    const siteNameEl: HTMLDivElement = document.createElement('div');
    siteNameEl.className = 'text-xs text-gray-500 mb-1';
    siteNameEl.textContent = siteName;
    body.appendChild(siteNameEl);
  }

  const titleEl: HTMLDivElement = document.createElement('div');
  titleEl.className = 'font-semibold text-gray-900 text-sm mb-1 line-clamp-2';
  titleEl.textContent = title;
  body.appendChild(titleEl);

  if (description) {
    const descriptionEl: HTMLDivElement = document.createElement('div');
    descriptionEl.className = 'text-xs text-gray-600 line-clamp-2';
    descriptionEl.textContent = description;
    body.appendChild(descriptionEl);
  }

  link.appendChild(body);
  card.appendChild(link);

  container.appendChild(card);
}

function renderTwitterEmbed(url: string, container: HTMLElement): void {
  const safeUrl: string | null = normalizeHttpUrl(url);
  if (!safeUrl) {
    return;
  }

  const card: HTMLDivElement = document.createElement('div');
  card.className =
    'my-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900';

  const label: HTMLDivElement = document.createElement('div');
  label.className = 'mb-2 font-semibold';
  label.textContent = 'X/Twitter post';

  const link: HTMLAnchorElement = document.createElement('a');
  link.href = safeUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'break-all text-sky-700 underline hover:text-sky-900';
  link.textContent = safeUrl;

  card.appendChild(label);
  card.appendChild(link);
  container.appendChild(card);
}

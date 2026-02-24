import { finalizeEvent, nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  OGPResponse,
  PubkeyHex,
} from '../../types/nostr';
import { fetchProfile } from '../features/profile/profile.js';
import { getRelays } from '../features/relays/relays.js';
import {
  fetchOGP,
  getAvatarURL,
  getDisplayName,
  isTwitterURL,
  replaceEmojiShortcodes,
} from '../utils/utils.js';
import { getCachedEvent, setCachedEvent } from './event-cache.js';
import { deleteEvents, removeEventFromTimeline } from './db/index.js';
import { computeTimelineRemovalTargets } from './deletion-targets.js';
import {
  cacheDeletionStatus,
  fetchEventById,
  getCachedDeletionStatus,
  isEventDeleted,
} from './events-queries.js';
import { createRelayWebSocket } from './relay-socket.js';
import { getSessionPrivateKey } from './session.js';

const REFERENCED_EVENT_CACHE_LIMIT: number = 1000;
const referencedEventCache: Map<string, Promise<NostrEvent | null>> = new Map();
interface ReactionAggregate {
  count: number;
  key: string;
  content: string;
  shortcode?: string;
  imageUrl?: string;
}

const reactionCache: Map<
  string,
  Promise<Map<string, ReactionAggregate>>
> = new Map();
const reactionEventsCache: Map<string, Promise<NostrEvent[]>> = new Map();

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

function isValidEmojiImageUrl(url: string): boolean {
  try {
    const parsed: URL = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

function normalizeHttpUrl(url: string): string | null {
  try {
    const parsed: URL = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getEmojiTagMap(tags: string[][]): Map<string, string> {
  const emojiTagMap: Map<string, string> = new Map();
  tags.forEach((tag: string[]): void => {
    if (tag[0] !== 'emoji') {
      return;
    }
    const shortcode: string | undefined = tag[1];
    const imageUrl: string | undefined = tag[2];
    if (!shortcode || !imageUrl) {
      return;
    }
    if (!/^[a-z0-9_]+$/i.test(shortcode)) {
      return;
    }
    if (!isValidEmojiImageUrl(imageUrl)) {
      return;
    }
    emojiTagMap.set(shortcode.toLowerCase(), imageUrl);
  });
  return emojiTagMap;
}

function replaceCustomEmojiShortcodes(
  content: string,
  tags: string[][],
): string {
  const emojiTagMap: Map<string, string> = getEmojiTagMap(tags);

  if (emojiTagMap.size === 0) {
    return content;
  }

  return content.replace(
    /:([a-z0-9_]+):/gi,
    (match: string, code: string): string => {
      const imageUrl: string | undefined = emojiTagMap.get(code.toLowerCase());
      if (!imageUrl) {
        return match;
      }
      const safeCode: string = escapeHtmlAttribute(code);
      const safeUrl: string = escapeHtmlAttribute(imageUrl);
      return `<img src="${safeUrl}" alt=":${safeCode}:" title=":${safeCode}:" class="inline-block align-text-bottom h-5 w-5 mx-0.5" loading="lazy" decoding="async" />`;
    },
  );
}

function setReferencedEventCache(
  eventId: string,
  request: Promise<NostrEvent | null>,
): void {
  referencedEventCache.delete(eventId);
  referencedEventCache.set(eventId, request);
  if (referencedEventCache.size > REFERENCED_EVENT_CACHE_LIMIT) {
    const oldestKey: string | undefined = referencedEventCache
      .keys()
      .next().value;
    if (oldestKey) {
      referencedEventCache.delete(oldestKey);
    }
  }
}

async function fetchEventByIdCached(
  eventId: string,
  relays: string[],
): Promise<NostrEvent | null> {
  const cached: Promise<NostrEvent | null> | undefined =
    referencedEventCache.get(eventId);
  if (cached) {
    setReferencedEventCache(eventId, cached);
    return cached;
  }

  const request: Promise<NostrEvent | null> =
    (async (): Promise<NostrEvent | null> => {
      const cachedEvent: NostrEvent | null = await getCachedEvent(eventId);
      if (cachedEvent) {
        return cachedEvent;
      }
      const event: NostrEvent | null = await fetchEventById(eventId, relays);
      if (event) {
        await setCachedEvent(event);
        return event;
      }
      referencedEventCache.delete(eventId);
      return null;
    })();
  setReferencedEventCache(eventId, request);
  return request;
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

  const request: Promise<Map<string, ReactionAggregate>> = new Promise<
    Map<string, ReactionAggregate>
  >((resolve) => {
    const counts: Map<string, ReactionAggregate> = new Map();
    const seenReactionIds: Set<string> = new Set();

    const promises = relays.map(async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((innerResolve) => {
          let settled: boolean = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.close();
            innerResolve();
          };

          const timeout = setTimeout(() => {
            finish();
          }, 5000);

          socket.onopen = (): void => {
            const subId: string = `reactions-${Math.random().toString(36).slice(2)}`;
            const req: [
              string,
              string,
              { kinds: number[]; '#e': string[]; limit: number },
            ] = ['REQ', subId, { kinds: [7], '#e': [eventId], limit: 50 }];
            socket.send(JSON.stringify(req));
          };

          socket.onmessage = (msg: MessageEvent): void => {
            const arr: any[] = JSON.parse(msg.data);
            if (arr[0] === 'EVENT' && arr[2]) {
              const event: NostrEvent = arr[2];
              if (event.kind !== 7 || seenReactionIds.has(event.id)) {
                return;
              }
              seenReactionIds.add(event.id);
              const reaction: ReactionAggregate = getReactionAggregate(
                event.content,
                event.tags,
              );
              const existing: ReactionAggregate | undefined = counts.get(
                reaction.key,
              );
              if (existing) {
                existing.count += 1;
              } else {
                counts.set(reaction.key, reaction);
              }
            } else if (arr[0] === 'EOSE') {
              finish();
            }
          };

          socket.onerror = (): void => {
            finish();
          };
        });
      } catch (e) {
        console.warn(`Failed to fetch reactions from ${relayUrl}:`, e);
      }
    });

    Promise.allSettled(promises).then(() => {
      resolve(counts);
    });
  });

  reactionCache.set(eventId, request);
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

  const request: Promise<NostrEvent[]> = new Promise<NostrEvent[]>(
    (resolve) => {
      const events: Map<string, NostrEvent> = new Map();

      const promises = relays.map(async (relayUrl: string): Promise<void> => {
        try {
          const socket: WebSocket = createRelayWebSocket(relayUrl);
          await new Promise<void>((innerResolve) => {
            let settled: boolean = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              socket.close();
              innerResolve();
            };

            const timeout = setTimeout(() => {
              finish();
            }, 5000);

            socket.onopen = (): void => {
              const subId: string = `reactions-events-${Math.random().toString(36).slice(2)}`;
              const req: [
                string,
                string,
                { kinds: number[]; '#e': string[]; limit: number },
              ] = ['REQ', subId, { kinds: [7], '#e': [eventId], limit: 100 }];
              socket.send(JSON.stringify(req));
            };

            socket.onmessage = (msg: MessageEvent): void => {
              const arr: any[] = JSON.parse(msg.data);
              if (arr[0] === 'EVENT' && arr[2]) {
                const event: NostrEvent = arr[2];
                if (event.kind !== 7) {
                  return;
                }
                events.set(event.id, event);
              } else if (arr[0] === 'EOSE') {
                finish();
              }
            };

            socket.onerror = (): void => {
              finish();
            };
          });
        } catch (e) {
          console.warn(`Failed to fetch reaction events from ${relayUrl}:`, e);
        }
      });

      Promise.allSettled(promises).then(() => {
        const list: NostrEvent[] = Array.from(events.values());
        list.sort(
          (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
        );
        resolve(list);
      });
    },
  );

  reactionEventsCache.set(eventId, request);
  return request;
}

function normalizeReaction(content: string | undefined): string {
  const trimmed: string = replaceEmojiShortcodes(content || '').trim();
  return trimmed ? trimmed : '❤';
}

function getReactionAggregate(
  content: string | undefined,
  tags: string[][],
): ReactionAggregate {
  const normalizedContent: string = normalizeReaction(content);
  const customMatch: RegExpMatchArray | null =
    normalizedContent.match(/^:([a-z0-9_]+):$/i);
  const shortcodeMatch: string | undefined = customMatch?.[1];
  if (shortcodeMatch) {
    const shortcode: string = shortcodeMatch;
    const emojiTagMap: Map<string, string> = getEmojiTagMap(tags);
    const imageUrl: string | undefined = emojiTagMap.get(
      shortcode.toLowerCase(),
    );
    if (imageUrl) {
      return {
        count: 1,
        key: `custom:${shortcode.toLowerCase()}:${imageUrl}`,
        content: `:${shortcode}:`,
        shortcode,
        imageUrl,
      };
    }
  }
  return {
    count: 1,
    key: `text:${normalizedContent}`,
    content: normalizedContent,
  };
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchEventWithRetry(
  eventId: string,
  relays: string[],
  attempts: number = 4,
): Promise<NostrEvent | null> {
  for (let i = 0; i < attempts; i += 1) {
    const event: NostrEvent | null = await fetchEventByIdCached(
      eventId,
      relays,
    );
    if (event) {
      return event;
    }
    if (i < attempts - 1) {
      await delay(800 + i * 600);
    }
  }
  return null;
}

export async function loadReactionsForEvent(
  eventId: string,
  targetPubkey: PubkeyHex,
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
    const top: ReactionAggregate[] = entries.slice(0, 5);

    container.innerHTML = '';
    top.forEach((reaction: ReactionAggregate): void => {
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
        imageEl.className = 'inline-block h-5 w-5 align-text-bottom';
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

      badge.addEventListener('click', (event: MouseEvent): void => {
        event.preventDefault();
        publishReaction(eventId, targetPubkey, reaction);
      });
      container.appendChild(badge);
    });
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

    await Promise.allSettled(
      filtered.slice(0, 20).map(async (event: NostrEvent): Promise<void> => {
        let profile: NostrProfile | null = null;
        try {
          profile = await fetchProfile(event.pubkey, relays);
        } catch (error: unknown) {
          console.warn('Failed to load profile for reaction:', error);
        }

        const npub: Npub = nip19.npubEncode(event.pubkey);
        const name: string = getDisplayName(npub, profile);
        const avatar: string = getAvatarURL(event.pubkey, profile);

        const row: HTMLAnchorElement = document.createElement('a');
        row.className =
          'flex items-center gap-2 text-sm text-gray-700 hover:text-blue-600 transition-colors';
        row.href = `/${npub}`;

        const img: HTMLImageElement = document.createElement('img');
        img.src = avatar;
        img.alt = name;
        img.className = 'w-6 h-6 rounded-full object-cover';
        img.onerror = (): void => {
          img.src = 'https://placekitten.com/80/80';
        };

        const nameEl: HTMLSpanElement = document.createElement('span');
        nameEl.textContent = name;

        row.appendChild(img);
        row.appendChild(nameEl);
        list.appendChild(row);
      }),
    );
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
): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    alert('Sign in to react.');
    return;
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: 7,
    pubkey: storedPubkey as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      ['p', targetPubkey],
    ],
    content: reaction.content,
  };
  if (reaction.shortcode && reaction.imageUrl) {
    unsignedEvent.tags.push(['emoji', reaction.shortcode, reaction.imageUrl]);
  }

  let signedEvent: NostrEvent;
  if ((window as any).nostr?.signEvent) {
    signedEvent = await (window as any).nostr.signEvent(unsignedEvent);
  } else {
    const privateKey: Uint8Array | null = getSessionPrivateKey();
    if (!privateKey) {
      alert('Sign in to react.');
      return;
    }
    signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
  }

  const relays: string[] = getRelays();
  const promises = relays.map(async (relayUrl: string): Promise<void> => {
    try {
      const socket: WebSocket = createRelayWebSocket(relayUrl);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.close();
          resolve();
        }, 5000);

        socket.onopen = (): void => {
          socket.send(JSON.stringify(['EVENT', signedEvent]));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'OK') {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        };

        socket.onerror = (): void => {
          clearTimeout(timeout);
          socket.close();
          resolve();
        };
      });
    } catch (e) {
      console.warn(`Failed to publish reaction to ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);
}

async function publishRepost(targetEvent: NostrEvent): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    alert('Sign in to repost.');
    return;
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: 6,
    pubkey: storedPubkey as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', targetEvent.id],
      ['p', targetEvent.pubkey],
    ],
    content: JSON.stringify(targetEvent),
  };

  let signedEvent: NostrEvent;
  if ((window as any).nostr?.signEvent) {
    signedEvent = await (window as any).nostr.signEvent(unsignedEvent);
  } else {
    const privateKey: Uint8Array | null = getSessionPrivateKey();
    if (!privateKey) {
      alert('Sign in to repost.');
      return;
    }
    signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
  }

  const relays: string[] = getRelays();
  const promises = relays.map(async (relayUrl: string): Promise<void> => {
    try {
      const socket: WebSocket = createRelayWebSocket(relayUrl);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.close();
          resolve();
        }, 5000);

        socket.onopen = (): void => {
          socket.send(JSON.stringify(['EVENT', signedEvent]));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'OK') {
            clearTimeout(timeout);
            socket.close();
            resolve();
          }
        };

        socket.onerror = (): void => {
          clearTimeout(timeout);
          socket.close();
          resolve();
        };
      });
    } catch (e) {
      console.warn(`Failed to publish repost to ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);
}

export function renderEvent(
  event: NostrEvent,
  profile: NostrProfile | null,
  npub: Npub,
  pubkey: PubkeyHex,
  output: HTMLElement,
): void {
  const isRepost: boolean = event.kind === 6 || event.kind === 16;
  const repostEventId: string | null = isRepost
    ? resolveRepostEventId(event)
    : null;
  const avatar: string = getAvatarURL(pubkey, profile);
  const name: string = getDisplayName(npub, profile);
  const safeName: string = escapeHtmlAttribute(name);
  const safeNpub: string = escapeHtmlAttribute(npub);
  const createdAt: string = new Date(event.created_at * 1000).toLocaleString();
  const timeLabel: string = formatEventTimeLabel(event.created_at);
  let eventPermalink: string | null = null;
  try {
    eventPermalink = `/${nip19.neventEncode({ id: event.id })}`;
  } catch (e) {
    console.warn('Failed to encode nevent for event link:', e);
    eventPermalink = null;
  }
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  const canDeletePost: boolean = Boolean(
    storedPubkey && storedPubkey === event.pubkey,
  );
  const isLoggedIn: boolean = Boolean(storedPubkey);
  const actionBtnBase: string =
    'event-action-btn inline-flex items-center justify-center p-1 rounded transition-colors';
  const actionBtnDisabled: string = 'opacity-60 cursor-not-allowed';

  const replyButtonTitle: string = isLoggedIn
    ? 'Reply'
    : 'Reply (sign-in required)';
  const replyButtonClasses: string = `${actionBtnBase} reply-event-btn text-blue-600 hover:text-blue-800 hover:bg-blue-50`;

  const repostButtonTitle: string = isLoggedIn
    ? 'Repost'
    : 'Repost (sign-in required)';
  const repostButtonClasses: string = isLoggedIn
    ? `${actionBtnBase} repost-event-btn text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50`
    : `${actionBtnBase} repost-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const reactButtonTitle: string = isLoggedIn
    ? 'React'
    : 'React (sign-in required)';
  const reactButtonClasses: string = isLoggedIn
    ? `${actionBtnBase} react-event-btn text-rose-600 hover:text-rose-800 hover:bg-rose-50`
    : `${actionBtnBase} react-event-btn text-gray-400 hover:text-gray-500 ${actionBtnDisabled}`;

  const deleteButtonTitle: string = 'Delete post';
  const deleteButtonClasses: string = `${actionBtnBase} delete-event-btn text-red-600 hover:text-red-800 hover:bg-red-50`;

  const actionBarHtml: string = `
          <div class="flex items-center gap-1">
            <button class="${replyButtonClasses}" aria-label="Reply to post" title="${replyButtonTitle}" data-event-id="${escapeHtmlAttribute(event.id)}" data-event-pubkey="${escapeHtmlAttribute(event.pubkey)}" data-event-author="${safeName}">
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
              canDeletePost
                ? `<button class="${deleteButtonClasses}" aria-label="${deleteButtonTitle}" title="${deleteButtonTitle}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M14 11v6" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 7l1 14h10l1-14" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 7V4h6v3" />
                    </svg>
                  </button>`
                : ''
            }
          </div>
        `;

  const contentSource: string = isRepost ? '' : event.content;
  const escapedContentSource: string = escapeHtmlAttribute(contentSource);
  const urls: string[] = [];
  const imageUrls: string[] = [];
  const mentionedNpubs: string[] = Array.from(
    new Set(
      [...contentSource.matchAll(/nostr:(npub1[0-9a-z]+)/gi)]
        .map((match: RegExpMatchArray): string | undefined => match[1])
        .filter((value: string | undefined): value is string => Boolean(value)),
    ),
  );
  const mentionedNprofiles: string[] = Array.from(
    new Set(
      [...contentSource.matchAll(/nostr:(nprofile1[0-9a-z]+)/gi)]
        .map((match: RegExpMatchArray): string | undefined => match[1])
        .filter((value: string | undefined): value is string => Boolean(value)),
    ),
  );
  const mentionNpubToPubkey: Map<string, PubkeyHex> = new Map();
  mentionedNpubs.forEach((mentionedNpub: string): void => {
    try {
      const decoded = nip19.decode(mentionedNpub);
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        mentionNpubToPubkey.set(mentionedNpub, decoded.data as PubkeyHex);
      }
    } catch (error: unknown) {
      console.warn('Failed to decode mentioned npub:', error);
    }
  });
  mentionedNprofiles.forEach((mentionedNprofile: string): void => {
    try {
      const decoded = nip19.decode(mentionedNprofile);
      if (decoded.type === 'nprofile') {
        const data: any = decoded.data;
        const pubkey: string | undefined =
          data?.pubkey || (typeof data === 'string' ? data : undefined);
        if (pubkey) {
          mentionNpubToPubkey.set(mentionedNprofile, pubkey as PubkeyHex);
        }
      }
    } catch (error: unknown) {
      console.warn('Failed to decode mentioned nprofile:', error);
    }
  });
  const referencedEventRefs: string[] = Array.from(
    new Set(
      [...contentSource.matchAll(/nostr:((?:nevent1|note1)[0-9a-z]+)/gi)]
        .map((match: RegExpMatchArray): string | undefined => match[1])
        .filter((value: string | undefined): value is string => Boolean(value)),
    ),
  );
  const parentEventId: string | null = isRepost
    ? null
    : resolveParentEventId(event);
  const parentAuthorPubkey: PubkeyHex | null = parentEventId
    ? resolveParentAuthorPubkey(event)
    : null;
  const contentWithUnicodeEmoji: string =
    replaceEmojiShortcodes(escapedContentSource);
  const contentWithNostrLinks: string = contentWithUnicodeEmoji.replace(
    /(nostr:(?:nevent1|note1)[0-9a-z]+)/gi,
    (): string => '',
  );

  const contentWithNprofiles: string = contentWithNostrLinks.replace(
    /(nostr:nprofile1[0-9a-z]+)/gi,
    (nprofileRef: string): string => {
      const mentionedNprofile: string = nprofileRef.replace(/^nostr:/i, '');
      const pubkey: PubkeyHex | undefined =
        mentionNpubToPubkey.get(mentionedNprofile);
      if (pubkey) {
        const npub: Npub = nip19.npubEncode(pubkey);
        const label: string = `@${mentionedNprofile.slice(0, 12)}...`;
        return `<a href="/${npub}" class="text-indigo-600 underline mention-link" data-mention-nprofile="${mentionedNprofile}">${label}</a>`;
      }
      return nprofileRef;
    },
  );

  const contentWithMentions: string = contentWithNprofiles.replace(
    /(nostr:npub1[0-9a-z]+)/gi,
    (npubRef: string): string => {
      const mentionedNpub: string = npubRef.replace(/^nostr:/i, '');
      const label: string = `@${mentionedNpub.slice(0, 12)}...`;
      return `<a href="/${mentionedNpub}" class="text-indigo-600 underline mention-link" data-mention-npub="${mentionedNpub}">${label}</a>`;
    },
  );

  // Check energy saving mode
  const isEnergySavingMode: boolean =
    localStorage.getItem('energy_saving_mode') === 'true';

  const contentWithLinks: string = contentWithMentions.replace(
    /(https?:\/\/[^\s]+)/g,
    (url: string): string => {
      const safeUrl: string | null = normalizeHttpUrl(url);
      if (!safeUrl) {
        return url;
      }

      if (safeUrl.match(/\.(jpeg|jpg|gif|png|webp|svg|mp4|webm|mov|avi)$/i)) {
        const imageIndex: number = imageUrls.length;
        imageUrls.push(safeUrl);

        // In energy saving mode, show link instead of loading media
        if (isEnergySavingMode) {
          const fileName: string = safeUrl.split('/').pop() || 'media';
          return `<div class="my-2 p-2 bg-gray-100 rounded border border-gray-300"><span class="text-gray-600 text-xs">🖼️ Image: </span><a href="${escapeHtmlAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-500 underline text-sm">${escapeHtmlAttribute(fileName)}</a></div>`;
        }

        return `<img src="${escapeHtmlAttribute(safeUrl)}" alt="Image" class="my-2 max-w-full rounded shadow cursor-zoom-in event-image" loading="lazy" data-image-index="${imageIndex}" />`;
      }

      urls.push(safeUrl);
      return `<a href="${escapeHtmlAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-500 underline">${escapeHtmlAttribute(safeUrl)}</a>`;
    },
  );

  const contentWithCustomEmoji: string = replaceCustomEmojiShortcodes(
    contentWithLinks,
    event.tags,
  );
  const hasContent: boolean = contentWithCustomEmoji.trim().length > 0;
  const repostBadgeHtml: string = isRepost
    ? `<span class="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold px-2 py-0.5">🔁 Repost</span>`
    : '';
  const contentHtml: string = hasContent
    ? `<div class="whitespace-pre-wrap break-words break-all mb-2 text-sm text-gray-700">${contentWithCustomEmoji}</div>`
    : '';

  const div: HTMLDivElement = document.createElement('div');
  div.className =
    'bg-gray-50 border border-gray-200 rounded p-4 shadow event-container cursor-pointer hover:bg-gray-100/60 transition-colors';
  // Used by timelines to keep DOM ordering stable without re-rendering.
  div.dataset.eventId = event.id;
  div.dataset.createdAt = String(event.created_at);
  div.dataset.pubkey = pubkey;
  div.dataset.timestamp = event.created_at.toString();
  if (imageUrls.length > 0) {
    div.dataset.images = JSON.stringify(imageUrls);
  }
  // Avatar display based on energy saving mode
  const safeAvatar: string =
    normalizeHttpUrl(avatar) || 'https://placekitten.com/100/100';
  const avatarHtml: string = isEnergySavingMode
    ? `<div class="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-xl">👤</div>`
    : `<img src="${escapeHtmlAttribute(safeAvatar)}" alt="Avatar" class="event-avatar w-12 h-12 rounded-full object-cover cursor-pointer"
         onerror="this.src='https://placekitten.com/100/100';" />`;

  div.innerHTML = `
					    <div class="flex items-start space-x-4">
				      <a href="/${safeNpub}" class="flex-shrink-0 hover:opacity-80 transition-opacity">
				        ${avatarHtml}
				      </a>
				      <div class="flex-1 overflow-x-hidden overflow-y-visible">
			        <div class="flex items-center gap-2 min-w-0 mb-1">
			          <a href="/${safeNpub}" class="event-username min-w-0 truncate font-semibold text-gray-800 text-sm hover:text-blue-600 transition-colors">👤 ${safeName}</a>
			          ${
                  eventPermalink
                    ? `<a href="${eventPermalink}" class="flex-none text-xs text-gray-500 hover:text-blue-600 transition-colors" title="${escapeHtmlAttribute(createdAt)}">${escapeHtmlAttribute(timeLabel)}</a>`
                    : `<span class="flex-none text-xs text-gray-500" title="${escapeHtmlAttribute(createdAt)}">${escapeHtmlAttribute(timeLabel)}</span>`
                }
			        </div>
		        ${repostBadgeHtml}
              ${eventPermalink ? `<a class="event-permalink" href="${eventPermalink}" aria-hidden="true" tabindex="-1" style="display:none;"></a>` : ''}
		            <div class="parent-event-container mb-2"></div>
					        ${contentHtml}
		            <div class="referenced-events-container space-y-2"></div>
		            <div class="ogp-container"></div>
		            <div class="reactions-container mt-2 flex flex-wrap gap-2 text-xs text-gray-600"></div>
		            <div class="reactions-details mt-2" style="display: none;"></div>
		            <div class="mt-2 flex items-center justify-between gap-2">
		              ${actionBarHtml}
		            </div>
				      </div>
				    </div>
				  `;

  // Insert event in sorted order by timestamp (newest first)
  const existingEvents: HTMLElement[] = Array.from(
    output.querySelectorAll('.event-container'),
  );
  let inserted: boolean = false;

  for (const existingEvent of existingEvents) {
    const existingTimestamp: number = parseInt(
      existingEvent.dataset.timestamp || '0',
      10,
    );
    if (event.created_at > existingTimestamp) {
      output.insertBefore(div, existingEvent);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    output.appendChild(div);
  }
  if (parentEventId) {
    const parentContainer: HTMLElement | null = div.querySelector(
      '.parent-event-container',
    );
    if (parentContainer) {
      renderParentEventCard(parentEventId, parentAuthorPubkey, parentContainer);
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
      // Trigger reply overlay via custom event
      const replyEvent = new CustomEvent('open-reply', {
        detail: {
          eventId: event.id,
          eventPubkey: event.pubkey,
          eventAuthor: name,
          eventContent: contentSource,
        },
      });
      window.dispatchEvent(replyEvent);
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
          await publishRepost(event);
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
        const reaction: ReactionAggregate = {
          count: 1,
          key: 'text:❤',
          content: '❤',
        };
        try {
          await publishReaction(event.id, event.pubkey, reaction);
        } catch (error: unknown) {
          console.error('Failed to react:', error);
          alert('Failed to react. Please try again.');
        }
      },
    );
  }

  const deleteButton: HTMLButtonElement | null = div.querySelector(
    '.delete-event-btn',
  ) as HTMLButtonElement | null;
  if (deleteButton) {
    deleteButton.addEventListener(
      'click',
      async (e: MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        const confirmed: boolean = window.confirm('Delete this post?');
        if (!confirmed) {
          return;
        }

        deleteButton.disabled = true;
        deleteButton.classList.add('opacity-60', 'cursor-not-allowed');

        try {
          await deleteEventOnRelays(event);
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
        } catch (error: unknown) {
          console.error('Failed to delete event:', error);
          alert('Failed to delete post. Please try again.');
          deleteButton.disabled = false;
          deleteButton.classList.remove('opacity-60', 'cursor-not-allowed');
        }
      },
    );
  }

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
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('select') ||
        target.closest('.reactions-container') ||
        target.closest('.reactions-details')
      ) {
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

function resolveParentEventId(event: NostrEvent): string | null {
  const eTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  if (eTags.length === 0) {
    return null;
  }

  const replyTag: string[] | undefined = eTags.find(
    (tag: string[]): boolean => tag[3] === 'reply',
  );
  if (replyTag?.[1]) {
    return replyTag[1];
  }

  const rootTag: string[] | undefined = eTags.find(
    (tag: string[]): boolean => tag[3] === 'root',
  );
  if (rootTag?.[1]) {
    return rootTag[1];
  }

  return eTags[eTags.length - 1]?.[1] || null;
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

async function renderParentEventCard(
  parentEventId: string,
  parentAuthorPubkey: PubkeyHex | null,
  container: HTMLElement,
): Promise<void> {
  container.innerHTML = '';
  const card: HTMLDivElement = document.createElement('div');
  card.className = 'border border-amber-200 bg-amber-50 rounded-lg p-3';
  card.textContent = 'Loading parent post...';
  container.appendChild(card);

  try {
    const relays: string[] = getRelays();
    if (parentAuthorPubkey) {
      const cachedStatus: boolean | undefined =
        getCachedDeletionStatus(parentEventId);
      if (cachedStatus === true) {
        card.textContent = 'Parent post was deleted.';
        return;
      }
      if (cachedStatus === undefined) {
        checkDeletionAsync(
          parentEventId,
          parentAuthorPubkey,
          relays,
          card,
          'Parent post was deleted.',
        );
      }
    }

    const parentEvent: NostrEvent | null = await fetchEventWithRetry(
      parentEventId,
      relays,
      3,
    );
    if (!parentEvent) {
      card.textContent = 'Failed to load parent post.';
      return;
    }

    const parentProfile: NostrProfile | null = await fetchProfile(
      parentEvent.pubkey,
      relays,
    );
    const parentNpub: Npub = nip19.npubEncode(parentEvent.pubkey);
    const parentName: string = getDisplayName(parentNpub, parentProfile);
    const parentAvatar: string = getAvatarURL(
      parentEvent.pubkey,
      parentProfile,
    );
    const parentContentWithUnicodeEmoji: string = replaceEmojiShortcodes(
      escapeHtmlAttribute(parentEvent.content),
    );
    const parentContent: string = replaceCustomEmojiShortcodes(
      parentContentWithUnicodeEmoji,
      parentEvent.tags,
    );
    const preview: string =
      parentContent.length > 220
        ? `${parentContent.slice(0, 220)}...`
        : parentContent;
    const parentPath: string = `/${nip19.neventEncode({ id: parentEvent.id })}`;
    const safeParentPath: string = escapeHtmlAttribute(parentPath);
    const safeParentName: string = escapeHtmlAttribute(parentName);

    const isEnergySavingMode: boolean =
      localStorage.getItem('energy_saving_mode') === 'true';
    const safeParentAvatar: string =
      normalizeHttpUrl(parentAvatar) || 'https://placekitten.com/80/80';
    const parentAvatarHtml: string = isEnergySavingMode
      ? `<div class="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-sm flex-shrink-0">👤</div>`
      : `<img
          src="${escapeHtmlAttribute(safeParentAvatar)}"
          alt="${safeParentName}"
          class="w-8 h-8 rounded-full object-cover flex-shrink-0"
          onerror="this.src='https://placekitten.com/80/80';"
        />`;

    card.innerHTML = `
      <a href="${safeParentPath}" class="block hover:bg-amber-100 rounded transition-colors p-1">
        <div class="text-xs text-amber-700 font-semibold mb-1">Replying to</div>
        <div class="flex items-start gap-2">
          ${parentAvatarHtml}
          <div class="min-w-0">
            <div class="text-xs text-gray-700 font-semibold mb-1 truncate">${safeParentName}</div>
            <div class="text-sm text-gray-800 whitespace-pre-wrap break-words">${preview || '(no content)'}</div>
          </div>
        </div>
      </a>
    `;
  } catch (error: unknown) {
    console.warn('Failed to render parent event card:', error);
    card.textContent = 'Failed to load parent post.';
  }
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
      const mentionedNpub: Npub = nip19.npubEncode(mentionedPubkey);
      const displayName: string = getDisplayName(
        mentionedNpub,
        mentionedProfile,
      );

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

async function deleteEventOnRelays(targetEvent: NostrEvent): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey || storedPubkey !== targetEvent.pubkey) {
    throw new Error('You can only delete your own posts.');
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: 5,
    pubkey: storedPubkey as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', targetEvent.id]],
    content: '',
  };

  let signedEvent: NostrEvent;
  if ((window as any).nostr?.signEvent) {
    signedEvent = await (window as any).nostr.signEvent(unsignedEvent);
  } else {
    const privateKey: Uint8Array | null = getSessionPrivateKey();
    if (!privateKey) {
      throw new Error('No signing method available');
    }
    signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
  }

  const relays: string[] = getRelays();
  const publishPromises = relays.map(
    async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((resolve) => {
          let settled: boolean = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.close();
            resolve();
          };

          const timeout = setTimeout(() => {
            finish();
          }, 5000);

          socket.onopen = (): void => {
            socket.send(JSON.stringify(['EVENT', signedEvent]));
          };

          socket.onmessage = (msg: MessageEvent): void => {
            const arr: any[] = JSON.parse(msg.data);
            if (arr[0] === 'OK') {
              finish();
            }
          };

          socket.onerror = (): void => {
            finish();
          };
        });
      } catch (e) {
        console.warn(`Failed to publish delete event to ${relayUrl}:`, e);
      }
    },
  );

  await Promise.allSettled(publishPromises);
}

async function renderReferencedEventCards(
  eventRefs: string[],
  container: HTMLElement,
): Promise<void> {
  const currentRelays: string[] = getRelays();
  const maxCards: number = 3;

  for (const eventRef of eventRefs.slice(0, maxCards)) {
    const card: HTMLDivElement = document.createElement('div');
    card.className = 'border border-indigo-200 bg-indigo-50 rounded-lg p-3';
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
        relayHints = Array.isArray(data?.relays) ? data.relays : [];
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

      const relaysToUse: string[] =
        relayHints.length > 0 ? relayHints : currentRelays;
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

      const referencedEvent: NostrEvent | null = await fetchEventWithRetry(
        eventId,
        relaysToUse,
        3,
      );
      if (!referencedEvent) {
        card.textContent = 'Failed to load referenced event.';
        continue;
      }

      const referencedProfile: NostrProfile | null = await fetchProfile(
        referencedEvent.pubkey,
        relaysToUse,
      );
      const referencedNpub: Npub = nip19.npubEncode(referencedEvent.pubkey);
      const referencedName: string = getDisplayName(
        referencedNpub,
        referencedProfile,
      );
      const referencedAvatar: string = getAvatarURL(
        referencedEvent.pubkey,
        referencedProfile,
      );
      const referencedContentWithUnicodeEmoji: string = replaceEmojiShortcodes(
        escapeHtmlAttribute(referencedEvent.content),
      );
      const referencedContent: string = replaceCustomEmojiShortcodes(
        referencedContentWithUnicodeEmoji,
        referencedEvent.tags,
      );
      const referencedText: string =
        referencedContent.length > 180
          ? `${referencedContent.slice(0, 180)}...`
          : referencedContent;
      const referencedPath: string = `/${eventRef}`;
      const safeReferencedPath: string = escapeHtmlAttribute(referencedPath);
      const safeReferencedName: string = escapeHtmlAttribute(referencedName);

      const isEnergySavingMode: boolean =
        localStorage.getItem('energy_saving_mode') === 'true';
      const safeReferencedAvatar: string =
        normalizeHttpUrl(referencedAvatar) || 'https://placekitten.com/80/80';
      const referencedAvatarHtml: string = isEnergySavingMode
        ? `<div class="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-gray-600 text-sm flex-shrink-0">👤</div>`
        : `<img
            src="${escapeHtmlAttribute(safeReferencedAvatar)}"
            alt="${safeReferencedName}"
            class="w-8 h-8 rounded-full object-cover flex-shrink-0"
            onerror="this.src='https://placekitten.com/80/80';"
          />`;

      card.innerHTML = `
                <a href="${safeReferencedPath}" class="block hover:bg-indigo-100 rounded transition-colors p-1">
                    <div class="flex items-start gap-2">
                        ${referencedAvatarHtml}
                        <div class="min-w-0">
                            <div class="text-xs text-gray-700 font-semibold mb-1 truncate">${safeReferencedName}</div>
                            <div class="text-sm text-gray-800 whitespace-pre-wrap break-words">${referencedText || '(no content)'}</div>
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
  const title: string =
    ogpData.data['og:title'] || ogpData.data.title || 'No title';
  const description: string =
    ogpData.data['og:description'] || ogpData.data.description || '';
  const siteName: string = ogpData.data['og:site_name'] || '';
  const url: string | null = normalizeHttpUrl(ogpData.url);
  const image: string | null = ogpData.data['og:image']
    ? normalizeHttpUrl(ogpData.data['og:image'])
    : null;
  if (!url) {
    return;
  }

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

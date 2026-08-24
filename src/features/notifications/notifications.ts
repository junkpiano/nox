import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../../types/nostr';
import { isMuted } from '../../common/mute-state.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getDisplayName, replaceEmojiShortcodes } from '../../utils/utils.js';
import { fetchProfile, getAuthoritativeProfile } from '../profile/profile.js';
import { recordRelayFailure } from '../relays/relays.js';

interface LoadNotificationsOptions {
  relays: string[];
  limit: number;
  force?: boolean;
  isRouteActive?: () => boolean;
}

let lastFetchedAt: number = 0;
let cachedEvents: NostrEvent[] = [];

function classifyNotification(
  event: NostrEvent,
  targetPubkey: PubkeyHex,
): 'mention' | 'reply' | 'reaction' | null {
  if (event.kind === 7) {
    return 'reaction';
  }
  if (event.kind !== 1) {
    return null;
  }
  const hasPTarget: boolean = event.tags.some(
    (tag: string[]): boolean => tag[0] === 'p' && tag[1] === targetPubkey,
  );
  if (!hasPTarget) {
    return null;
  }
  const hasETag: boolean = event.tags.some(
    (tag: string[]): boolean => tag[0] === 'e',
  );
  return hasETag ? 'reply' : 'mention';
}

function getTargetEventId(event: NostrEvent): string | null {
  const eTag: string[] | undefined = event.tags.find(
    (tag: string[]): boolean => tag[0] === 'e',
  );
  return eTag?.[1] || null;
}

function renderNotifications(
  events: NostrEvent[],
  targetPubkey: PubkeyHex,
  container: HTMLElement,
  displayNames: Map<PubkeyHex, string>,
): void {
  container.innerHTML = '';

  // A muted account should not be able to reach the viewer by replying to or
  // reacting to their posts.
  events = events.filter(
    (event: NostrEvent): boolean => !isMuted(event.pubkey),
  );

  if (events.length === 0) {
    const empty: HTMLDivElement = document.createElement('div');
    empty.className = 'text-sm text-gray-500';
    empty.textContent = 'No notifications yet.';
    container.appendChild(empty);
    return;
  }

  events.forEach((event: NostrEvent): void => {
    const type = classifyNotification(event, targetPubkey);
    if (!type) {
      return;
    }

    const row: HTMLAnchorElement = document.createElement('a');
    row.className =
      'block rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 hover:bg-gray-100 transition-colors';

    const authorNpub: Npub = nip19.npubEncode(event.pubkey);
    const shortAuthor: string = `${authorNpub.slice(0, 10)}…${authorNpub.slice(-4)}`;
    const displayName: string = displayNames.get(event.pubkey) || shortAuthor;

    let label: string = '';
    let content: string = '';
    if (type === 'reaction') {
      label = 'Reacted';
      content = event.content ? event.content : 'Reaction';
    } else if (type === 'reply') {
      label = 'Replied';
      content = event.content || 'Reply';
    } else {
      label = 'Mentioned';
      content = event.content || 'Mention';
    }
    content = replaceEmojiShortcodes(content);

    const eventId: string | null = getTargetEventId(event);
    if (eventId) {
      const note: string = nip19.noteEncode(eventId);
      row.href = `/${note}`;
    } else {
      row.href = `/${authorNpub}`;
    }

    const header: HTMLDivElement = document.createElement('div');
    header.className = 'flex items-center justify-between gap-4';

    const labelEl: HTMLSpanElement = document.createElement('span');
    labelEl.className = 'font-semibold text-gray-800';
    labelEl.textContent = label;

    const authorEl: HTMLSpanElement = document.createElement('span');
    authorEl.className = 'text-xs text-gray-500';
    authorEl.textContent = shortAuthor;

    const authorLine: HTMLDivElement = document.createElement('div');
    authorLine.className = 'mt-1 text-xs text-gray-500';
    authorLine.textContent = `From ${displayName}`;

    const contentEl: HTMLDivElement = document.createElement('div');
    contentEl.className = 'mt-2 text-gray-600 break-words';
    contentEl.textContent = content;

    header.appendChild(labelEl);
    header.appendChild(authorEl);
    row.appendChild(header);
    row.appendChild(authorLine);
    row.appendChild(contentEl);

    container.appendChild(row);
  });
}

async function fetchNotifications(
  relays: string[],
  targetPubkey: PubkeyHex,
  limit: number,
): Promise<NostrEvent[]> {
  const results: Map<string, NostrEvent> = new Map();

  const promises = relays.map(async (relayUrl: string): Promise<void> => {
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
          recordRelayFailure(relayUrl);
          finish();
        }, 5000);

        socket.onopen = (): void => {
          const subId: string = `notif-${Math.random().toString(36).slice(2)}`;
          const req: [
            string,
            string,
            { kinds: number[]; '#p': string[]; limit: number },
          ] = ['REQ', subId, { kinds: [1, 7], '#p': [targetPubkey], limit }];
          socket.send(JSON.stringify(req));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'EVENT' && arr[2]) {
            const event: NostrEvent = arr[2];
            const type = classifyNotification(event, targetPubkey);
            if (type) {
              results.set(event.id, event);
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
      console.warn(`Failed to load notifications from ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);

  const events: NostrEvent[] = Array.from(results.values());
  events.sort(
    (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
  );
  return events.slice(0, limit);
}

export async function loadNotifications(
  options: LoadNotificationsOptions,
): Promise<NostrEvent[]> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    return [];
  }

  const now: number = Date.now();
  if (
    !options.force &&
    cachedEvents.length > 0 &&
    now - lastFetchedAt < 10000
  ) {
    return cachedEvents;
  }

  const events: NostrEvent[] = await fetchNotifications(
    options.relays,
    storedPubkey as PubkeyHex,
    options.limit,
  );
  cachedEvents = events;
  lastFetchedAt = now;
  return events;
}

export function clearNotifications(): void {
  cachedEvents = [];
  lastFetchedAt = 0;
}

export async function loadNotificationsPage(
  options: LoadNotificationsOptions,
): Promise<void> {
  const isRouteActive: () => boolean = options.isRouteActive || (() => true);
  if (!isRouteActive()) {
    return;
  }
  const output: HTMLElement | null = document.getElementById('nostr-output');
  const profileSection: HTMLElement | null =
    document.getElementById('profile-section');
  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');

  if (postsHeader) {
    postsHeader.textContent = 'Notifications';
    postsHeader.style.display = '';
  }

  if (profileSection) {
    profileSection.innerHTML = '';
    profileSection.className = '';
  }

  if (!output) {
    return;
  }

  if (!storedPubkey) {
    output.innerHTML =
      '<p class="text-gray-600">Sign in to view notifications.</p>';
    return;
  }

  output.innerHTML =
    '<div class="text-sm text-gray-500">Loading notifications...</div>';
  const events: NostrEvent[] = await loadNotifications({
    ...options,
    force: true,
  });
  if (!isRouteActive()) {
    return;
  }
  const displayNames: Map<PubkeyHex, string> = await loadDisplayNames(
    options.relays,
    events,
  );
  if (!isRouteActive()) {
    return;
  }

  output.innerHTML = '';
  const list: HTMLDivElement = document.createElement('div');
  list.id = 'notifications-list';
  list.className = 'space-y-3';
  output.appendChild(list);
  renderNotifications(events, storedPubkey as PubkeyHex, list, displayNames);
}

async function loadDisplayNames(
  relays: string[],
  events: NostrEvent[],
): Promise<Map<PubkeyHex, string>> {
  const pubkeys: PubkeyHex[] = Array.from(
    new Set(events.map((event: NostrEvent): PubkeyHex => event.pubkey)),
  );
  const displayNames: Map<PubkeyHex, string> = new Map();

  await Promise.allSettled(
    pubkeys.map(async (pubkey: PubkeyHex): Promise<void> => {
      try {
        const profile: NostrProfile | null = await fetchProfile(pubkey, relays);
        const renderProfile: NostrProfile | null = getAuthoritativeProfile(
          pubkey,
          profile,
        );
        const npub: Npub = nip19.npubEncode(pubkey);
        displayNames.set(pubkey, getDisplayName(npub, renderProfile));
      } catch (error: unknown) {
        console.warn(
          'Failed to load display name for notification author:',
          error,
        );
      }
    }),
  );

  return displayNames;
}

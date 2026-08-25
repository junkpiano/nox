import { nip19 } from 'nostr-tools';
import type {
  NostrEvent,
  NostrProfile,
  Npub,
  PubkeyHex,
} from '../../../types/nostr';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import {
  getAvatarURL,
  getDisplayName,
  replaceEmojiShortcodes,
} from '../../utils/utils.js';
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
  displayNames: Map<PubkeyHex, NostrProfile | null>,
): void {
  container.innerHTML = '';

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
      'flex gap-3 px-1 py-3 text-sm border-b border-white/10 last:border-b-0';

    const authorNpub: Npub = nip19.npubEncode(event.pubkey);
    const profile: NostrProfile | null = displayNames.get(event.pubkey) ?? null;
    const displayName: string = getDisplayName(authorNpub, profile);

    let label: string = '';
    let content: string = '';
    if (type === 'reaction') {
      label = 'reacted';
      content = event.content ? event.content : '❤';
    } else if (type === 'reply') {
      label = 'replied';
      content = event.content || '';
    } else {
      label = 'mentioned you';
      content = event.content || '';
    }
    content = replaceEmojiShortcodes(content);

    const eventId: string | null = getTargetEventId(event);
    if (eventId) {
      const note: string = nip19.noteEncode(eventId);
      row.href = `/${note}`;
    } else {
      row.href = `/${authorNpub}`;
    }

    // Who, first and largest. A list of notifications is scanned for people,
    // not for verbs, and the previous layout led with "Reacted" while the name
    // sat below in grey and the raw npub repeated it in the corner.
    const avatar: HTMLImageElement = document.createElement('img');
    avatar.className = 'h-10 w-10 flex-none rounded-full object-cover';
    avatar.loading = 'lazy';
    avatar.alt = '';
    avatar.src = getAvatarURL(event.pubkey, profile);

    const body: HTMLDivElement = document.createElement('div');
    body.className = 'min-w-0 flex-1';

    const line: HTMLDivElement = document.createElement('div');
    line.className = 'flex items-baseline gap-1';

    const nameEl: HTMLSpanElement = document.createElement('span');
    nameEl.className = 'truncate font-semibold';
    nameEl.textContent = displayName;

    const labelEl: HTMLSpanElement = document.createElement('span');
    labelEl.className = 'flex-none text-xs opacity-60';
    labelEl.textContent = label;

    line.append(nameEl, labelEl);

    const contentEl: HTMLDivElement = document.createElement('div');
    contentEl.className = 'mt-1 break-words opacity-80';
    contentEl.textContent = content;

    body.append(line, contentEl);
    row.append(avatar, body);

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
  const displayNames: Map<PubkeyHex, NostrProfile | null> =
    await loadDisplayNames(options.relays, events);
  if (!isRouteActive()) {
    return;
  }

  output.innerHTML = '';
  const list: HTMLDivElement = document.createElement('div');
  list.id = 'notifications-list';
  list.className = '';
  output.appendChild(list);
  renderNotifications(events, storedPubkey as PubkeyHex, list, displayNames);
}

async function loadDisplayNames(
  relays: string[],
  events: NostrEvent[],
): Promise<Map<PubkeyHex, NostrProfile | null>> {
  const pubkeys: PubkeyHex[] = Array.from(
    new Set(events.map((event: NostrEvent): PubkeyHex => event.pubkey)),
  );
  const displayNames: Map<PubkeyHex, NostrProfile | null> = new Map();

  await Promise.allSettled(
    pubkeys.map(async (pubkey: PubkeyHex): Promise<void> => {
      try {
        const profile: NostrProfile | null = await fetchProfile(pubkey, relays);
        displayNames.set(pubkey, getAuthoritativeProfile(pubkey, profile));
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

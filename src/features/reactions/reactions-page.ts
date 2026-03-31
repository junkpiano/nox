import { finalizeEvent, nip19 } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { deleteEvents } from '../../common/db/index.js';
import { filterDeletedReactionEvents } from '../../common/reaction-interactions.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getSessionPrivateKey } from '../../common/session.js';
import { setActiveNav } from '../../common/navigation.js';
import { recordRelayFailure } from '../relays/relays.js';

interface LoadReactionsPageOptions {
  relays: string[];
  limit: number;
  isRouteActive?: () => boolean;
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

function getTargetEventId(event: NostrEvent): string | null {
  const eTag: string[] | undefined = event.tags.find(
    (tag: string[]): boolean => tag[0] === 'e',
  );
  return eTag?.[1] || null;
}

async function fetchMyReactions(
  relays: string[],
  authorPubkey: PubkeyHex,
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
          const subId: string = `my-reactions-${Math.random().toString(36).slice(2)}`;
          const req: [
            string,
            string,
            { kinds: number[]; authors: string[]; limit: number },
          ] = ['REQ', subId, { kinds: [7], authors: [authorPubkey], limit }];
          socket.send(JSON.stringify(req));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'EVENT' && arr[2]?.kind === 7) {
            const event: NostrEvent = arr[2];
            results.set(event.id, event);
          } else if (arr[0] === 'EOSE') {
            finish();
          }
        };

        socket.onerror = (): void => {
          finish();
        };
      });
    } catch (e) {
      console.warn(`Failed to load reactions from ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);

  const events: NostrEvent[] = Array.from(results.values());
  const deletionEvents: NostrEvent[] = await fetchReactionDeletionEvents(
    relays,
    authorPubkey,
    events.map((event: NostrEvent): string => event.id),
  );
  const visibleEvents: NostrEvent[] = filterDeletedReactionEvents(
    events,
    deletionEvents,
  );
  visibleEvents.sort(
    (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
  );
  return visibleEvents.slice(0, limit);
}

async function fetchReactionDeletionEvents(
  relays: string[],
  authorPubkey: PubkeyHex,
  reactionIds: string[],
): Promise<NostrEvent[]> {
  if (reactionIds.length === 0) {
    return [];
  }

  const results: Map<string, NostrEvent> = new Map();
  const requestLimit: number = Math.max(50, reactionIds.length * 2);

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
          const subId: string = `my-reaction-deletes-${Math.random().toString(36).slice(2)}`;
          const req: [
            string,
            string,
            { kinds: number[]; authors: string[]; '#e': string[]; limit: number },
          ] = [
            'REQ',
            subId,
            {
              kinds: [5],
              authors: [authorPubkey],
              '#e': reactionIds,
              limit: requestLimit,
            },
          ];
          socket.send(JSON.stringify(req));
        };

        socket.onmessage = (msg: MessageEvent): void => {
          const arr: any[] = JSON.parse(msg.data);
          if (arr[0] === 'EVENT' && arr[2]?.kind === 5) {
            const event: NostrEvent = arr[2];
            results.set(event.id, event);
          } else if (arr[0] === 'EOSE') {
            finish();
          }
        };

        socket.onerror = (): void => {
          finish();
        };
      });
    } catch (error: unknown) {
      console.warn(`Failed to load reaction deletions from ${relayUrl}:`, error);
    }
  });

  await Promise.allSettled(promises);
  return Array.from(results.values());
}

async function deleteEventOnRelays(
  targetEvent: NostrEvent,
  relays: string[],
): Promise<void> {
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey || storedPubkey !== targetEvent.pubkey) {
    throw new Error('You can only delete your own reactions.');
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
            recordRelayFailure(relayUrl);
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

export async function loadReactionsPage(
  options: LoadReactionsPageOptions,
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

  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLElement | null =
    document.getElementById('nav-profile');
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  const reactionsButton: HTMLElement | null =
    document.getElementById('nav-reactions');
  setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    null,
  );
  if (reactionsButton) {
    reactionsButton.classList.remove('text-gray-700');
    reactionsButton.classList.add('bg-indigo-100', 'text-indigo-700');
  }

  const notificationsButton: HTMLElement | null =
    document.getElementById('nav-notifications');
  if (notificationsButton) {
    notificationsButton.classList.remove('bg-indigo-100', 'text-indigo-700');
    notificationsButton.classList.add('text-gray-700');
  }

  if (postsHeader) {
    postsHeader.textContent = 'Reactions';
    postsHeader.style.display = '';
  }

  if (profileSection) {
    profileSection.innerHTML = '';
    profileSection.className = '';
  }

  if (!output) {
    return;
  }

  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey) {
    output.innerHTML =
      '<p class="text-gray-600">Sign in to view reactions.</p>';
    return;
  }

  output.innerHTML =
    '<div class="text-sm text-gray-500">Loading reactions...</div>';
  const events: NostrEvent[] = await fetchMyReactions(
    options.relays,
    storedPubkey as PubkeyHex,
    options.limit,
  );
  if (!isRouteActive()) {
    return;
  }

  output.innerHTML = '';
  const list: HTMLDivElement = document.createElement('div');
  list.className = 'space-y-3';
  output.appendChild(list);

  if (events.length === 0) {
    const empty: HTMLDivElement = document.createElement('div');
    empty.className = 'text-sm text-gray-500';
    empty.textContent = 'No reactions yet.';
    list.appendChild(empty);
    return;
  }

  events.forEach((reactionEvent: NostrEvent): void => {
    const targetEventId: string | null = getTargetEventId(reactionEvent);
    const timeLabel: string = formatEventTimeLabel(reactionEvent.created_at);
    const createdAt: string = new Date(
      reactionEvent.created_at * 1000,
    ).toLocaleString();

    const row: HTMLDivElement = document.createElement('div');
    row.className =
      'rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 hover:bg-gray-100 transition-colors';

    const header: HTMLDivElement = document.createElement('div');
    header.className = 'flex items-center justify-between gap-4';

    const left: HTMLDivElement = document.createElement('div');
    left.className = 'min-w-0';

    const title: HTMLDivElement = document.createElement('div');
    title.className = 'font-semibold text-gray-800';
    title.textContent = `Reacted ${reactionEvent.content || '❤'}`;

    const meta: HTMLDivElement = document.createElement('div');
    meta.className = 'mt-1 text-xs text-gray-500 min-w-0 truncate';
    if (targetEventId) {
      const note: string = nip19.noteEncode(targetEventId);
      meta.innerHTML = `To <a href="/${note}" class="text-blue-600 underline">/${note.slice(0, 14)}…</a>`;
    } else {
      meta.textContent = 'Target event unknown';
    }

    left.appendChild(title);
    left.appendChild(meta);

    const right: HTMLDivElement = document.createElement('div');
    right.className = 'flex items-center gap-2 flex-none';

    const timeEl: HTMLSpanElement = document.createElement('span');
    timeEl.className = 'text-xs text-gray-500';
    timeEl.title = createdAt;
    timeEl.textContent = timeLabel;

    const deleteBtn: HTMLButtonElement = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className =
      'inline-flex items-center justify-center p-1 rounded text-red-600 hover:text-red-800 hover:bg-red-50 transition-colors';
    deleteBtn.title = 'Delete reaction';
    deleteBtn.setAttribute('aria-label', 'Delete reaction');
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4 block" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M14 11v6" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 7l1 14h10l1-14" />
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 7V4h6v3" />
      </svg>
    `;
    deleteBtn.addEventListener(
      'click',
      async (e: MouseEvent): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        const confirmed: boolean = window.confirm('Delete this reaction?');
        if (!confirmed) {
          return;
        }
        deleteBtn.disabled = true;
        deleteBtn.classList.add('opacity-60', 'cursor-not-allowed');
        try {
          await deleteEventOnRelays(reactionEvent, options.relays);
          await deleteEvents([reactionEvent.id]);
          row.remove();
        } catch (error: unknown) {
          console.error('Failed to delete reaction:', error);
          alert('Failed to delete reaction. Please try again.');
          deleteBtn.disabled = false;
          deleteBtn.classList.remove('opacity-60', 'cursor-not-allowed');
        }
      },
    );

    right.appendChild(timeEl);
    right.appendChild(deleteBtn);

    header.appendChild(left);
    header.appendChild(right);
    row.appendChild(header);

    list.appendChild(row);
  });
}

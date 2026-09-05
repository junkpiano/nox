import { createMoreMenu } from '../../common/more-menu.js';

/** normalizeRelayUrl takes a bare host or a ws(s):// URL; the error says the same. */
const RELAY_ADDRESS_ERROR: string =
  'Enter a relay address, like relay.example.com or wss://relay.example.com.';

import { createRelayWebSocket } from '../../common/relay-socket.js';
import type { SetActiveNavFn } from '../../common/types.js';

interface RelaysPageOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  getRelays: () => string[];
  setRelays: (relays: string[]) => void;
  normalizeRelayUrl: (rawUrl: string) => string | null;
  onRelaysChanged: () => void;
  onBroadcastRequested?: () => Promise<void>;
  onNip65ImportRequested?: () => Promise<void>;
  onNip65PublishRequested?: () => Promise<void>;
  profileSection: HTMLElement | null;
  output: HTMLElement | null;
}

export function loadRelaysPage(options: RelaysPageOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  const homeButton: HTMLElement | null = document.getElementById('nav-home');
  const globalButton: HTMLElement | null =
    document.getElementById('nav-global');
  const relaysButton: HTMLElement | null =
    document.getElementById('nav-relays');
  const profileLink: HTMLElement | null =
    document.getElementById('nav-profile');
  const settingsButton: HTMLElement | null =
    document.getElementById('nav-settings');
  options.setActiveNav(
    homeButton,
    globalButton,
    relaysButton,
    profileLink,
    settingsButton,
    relaysButton,
  );

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'Relays';
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  if (options.output) {
    options.output.innerHTML = `
      <div class="space-y-5 text-sm">
        <div class="text-gray-600">
          Servers used to send and receive posts.
        </div>
        <div class="bg-slate-50 border border-slate-200 text-slate-900 rounded-lg p-3 text-xs space-y-2">
          <div class="font-semibold">Advanced · NIP-65</div>
          <div class="text-slate-700">
            Share this relay list with other Nostr apps.
          </div>
          <div class="flex flex-col sm:flex-row gap-2">
            <button id="nip65-import"
              class="bg-slate-800 hover:bg-slate-900 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
              Import list
            </button>
            <button id="nip65-publish"
              class="bg-indigo-700 hover:bg-indigo-800 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
              Publish list
            </button>
            <span class="text-xs text-gray-500 self-center">You need to be signed in to publish.</span>
          </div>
          <p id="nip65-status" class="text-xs text-gray-600"></p>
        </div>
        <div class="flex flex-col sm:flex-row gap-2">
          <input id="relay-input" type="text" placeholder="wss://relay.example.com"
            class="border border-gray-300 rounded-lg px-4 py-2 flex-1 text-gray-700" />
          <button id="relay-add"
            class="bg-gradient-to-r from-slate-800 via-indigo-900 to-purple-950 hover:from-slate-900 hover:via-indigo-950 hover:to-purple-950 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow-lg">
            Add
          </button>
        </div>
        <p id="relay-error" class="text-sm text-red-600"></p>
        <div class="flex flex-col sm:flex-row gap-2">
          <button id="broadcast-posts"
            class="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
            Broadcast posts
          </button>
          <span class="text-xs text-gray-500 self-center">Re-send your recent posts to all relays, so a new one has them too.</span>
        </div>
        <p id="broadcast-status" class="text-xs text-gray-600"></p>
        <div id="relay-list" class="space-y-2"></div>
      </div>
    `;
  }

  const relayInput: HTMLInputElement | null = document.getElementById(
    'relay-input',
  ) as HTMLInputElement;
  const relayAddButton: HTMLElement | null =
    document.getElementById('relay-add');
  const relayError: HTMLElement | null = document.getElementById('relay-error');
  const relayListEl: HTMLElement | null = document.getElementById('relay-list');
  const broadcastButton: HTMLButtonElement | null = document.getElementById(
    'broadcast-posts',
  ) as HTMLButtonElement;
  const broadcastStatus: HTMLElement | null =
    document.getElementById('broadcast-status');
  const nip65ImportButton: HTMLButtonElement | null = document.getElementById(
    'nip65-import',
  ) as HTMLButtonElement;
  const nip65PublishButton: HTMLButtonElement | null = document.getElementById(
    'nip65-publish',
  ) as HTMLButtonElement;
  const nip65Status: HTMLElement | null =
    document.getElementById('nip65-status');

  let currentRelays: string[] = options.getRelays();
  let relayStatusSockets: WebSocket[] = [];
  let relayStatusTimeouts: number[] = [];

  function setError(message: string): void {
    if (relayError) {
      relayError.textContent = message;
    }
  }

  function clearError(): void {
    if (relayError) {
      relayError.textContent = '';
    }
  }

  function renderRelayList(): void {
    if (!relayListEl) return;
    relayListEl.innerHTML = '';
    relayStatusSockets.forEach((socket: WebSocket): void => {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    });
    relayStatusSockets = [];
    relayStatusTimeouts.forEach((timeoutId: number): void => {
      clearTimeout(timeoutId);
    });
    relayStatusTimeouts = [];

    if (currentRelays.length === 0) {
      const empty: HTMLDivElement = document.createElement('div');
      empty.className = 'text-gray-500';
      empty.textContent = 'No relays configured.';
      relayListEl.appendChild(empty);
      return;
    }

    currentRelays.forEach((relayUrl: string, index: number): void => {
      const row: HTMLDivElement = document.createElement('div');
      row.className = 'nox-relay-row';

      const urlText: HTMLSpanElement = document.createElement('span');
      urlText.className = 'nox-relay-url';
      urlText.textContent = relayUrl;
      urlText.title = relayUrl;

      const status: HTMLSpanElement = document.createElement('span');
      status.className =
        'text-xs font-semibold px-2 py-1 rounded-full bg-gray-200 text-gray-700';
      status.textContent = 'Checking...';

      // Four things a row can have done to it, behind one mark the size of
      // a thumb. Four symbol buttons in a line were four ways to hit the
      // wrong one, and the one that removed a relay had no second look.
      const move = (from: number, to: number): void => {
        clearError();
        if (to < 0 || to >= currentRelays.length) return;
        const reordered: string[] = [...currentRelays];
        const moved: string | undefined = reordered[from];
        const other: string | undefined = reordered[to];
        if (!moved || !other) return;
        reordered[to] = moved;
        reordered[from] = other;
        currentRelays = reordered;
        options.setRelays(currentRelays);
        options.onRelaysChanged();
        renderRelayList();
      };

      const menu: HTMLElement = createMoreMenu({
        label: `Actions for ${relayUrl}`,
        align: 'end',
        items: [
          {
            label: 'Move up',
            disabled: index === 0,
            onSelect: (): void => move(index, index - 1),
          },
          {
            label: 'Move down',
            disabled: index === currentRelays.length - 1,
            onSelect: (): void => move(index, index + 1),
          },
          {
            label: 'Edit address',
            onSelect: (): void => {
              clearError();
              const updatedRaw: string | null = window.prompt(
                'Relay address:',
                relayUrl,
              );
              if (updatedRaw === null) return;
              const normalized: string | null =
                options.normalizeRelayUrl(updatedRaw);
              if (!normalized) {
                setError(RELAY_ADDRESS_ERROR);
                return;
              }
              const isDuplicate: boolean = currentRelays.some(
                (url: string, i: number): boolean =>
                  url === normalized && i !== index,
              );
              if (isDuplicate) {
                setError('This relay is already in the list.');
                return;
              }
              currentRelays[index] = normalized;
              options.setRelays(currentRelays);
              options.onRelaysChanged();
              renderRelayList();
            },
          },
          {
            label: 'Remove',
            danger: true,
            onSelect: (): void => {
              clearError();
              // Losing a relay is losing what it held: the posts and profiles
              // this app reads from it stop arriving. Said once, before.
              const sure: boolean = window.confirm(
                `Remove ${relayUrl}?\n\nPosts and profiles it was providing stop loading here.`,
              );
              if (!sure) return;
              currentRelays = currentRelays.filter(
                (_: string, i: number): boolean => i !== index,
              );
              options.setRelays(currentRelays);
              options.onRelaysChanged();
              renderRelayList();
            },
          },
        ],
      });

      const actions: HTMLDivElement = document.createElement('div');
      actions.className = 'nox-relay-actions';
      actions.append(status, menu);
      row.append(urlText, actions);
      relayListEl.appendChild(row);

      checkRelayStatus(relayUrl, status);
    });
  }

  function checkRelayStatus(relayUrl: string, statusEl: HTMLElement): void {
    const socket: WebSocket = createRelayWebSocket(relayUrl, false);
    relayStatusSockets.push(socket);

    const timeoutId = window.setTimeout((): void => {
      statusEl.className =
        'text-xs font-semibold px-2 py-1 rounded-full bg-red-100 text-red-700';
      statusEl.textContent = 'Timeout';
      socket.close();
    }, 5000);
    relayStatusTimeouts.push(timeoutId);

    socket.onopen = (): void => {
      clearTimeout(timeoutId);
      statusEl.className =
        'text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700';
      statusEl.textContent = 'Online';
      socket.close();
    };

    socket.onerror = (): void => {
      clearTimeout(timeoutId);
      statusEl.className =
        'text-xs font-semibold px-2 py-1 rounded-full bg-red-100 text-red-700';
      statusEl.textContent = 'Offline';
      socket.close();
    };
  }

  if (relayAddButton) {
    relayAddButton.setAttribute('title', 'Add relay');
    relayAddButton.setAttribute('aria-label', 'Add relay');
    relayAddButton.addEventListener('click', (): void => {
      clearError();
      if (!relayInput) return;
      const normalized: string | null = options.normalizeRelayUrl(
        relayInput.value,
      );
      if (!normalized) {
        setError(RELAY_ADDRESS_ERROR);
        return;
      }
      if (currentRelays.includes(normalized)) {
        setError('This relay is already in the list.');
        return;
      }
      currentRelays = [...currentRelays, normalized];
      options.setRelays(currentRelays);
      options.onRelaysChanged();
      relayInput.value = '';
      renderRelayList();
    });
  }

  if (relayInput) {
    relayInput.addEventListener('keypress', (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && relayAddButton) {
        relayAddButton.click();
      }
    });
  }

  if (broadcastButton) {
    broadcastButton.addEventListener('click', async (): Promise<void> => {
      if (!options.onBroadcastRequested) {
        return;
      }
      broadcastButton.disabled = true;
      broadcastButton.classList.add('opacity-60', 'cursor-not-allowed');
      if (broadcastStatus) {
        broadcastStatus.textContent = 'Broadcasting posts...';
        broadcastStatus.className = 'text-xs text-gray-600';
      }
      try {
        await options.onBroadcastRequested();
      } finally {
        broadcastButton.disabled = false;
        broadcastButton.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    });
  }

  if (nip65ImportButton) {
    nip65ImportButton.addEventListener('click', async (): Promise<void> => {
      if (!options.onNip65ImportRequested) {
        return;
      }
      nip65ImportButton.disabled = true;
      nip65ImportButton.classList.add('opacity-60', 'cursor-not-allowed');
      if (nip65Status) {
        nip65Status.textContent = 'Importing from NIP-65...';
        nip65Status.className = 'text-xs text-gray-600';
      }
      try {
        await options.onNip65ImportRequested();
        currentRelays = options.getRelays();
        renderRelayList();
        if (nip65Status) {
          nip65Status.textContent = 'Imported relay list from NIP-65.';
          nip65Status.className = 'text-xs text-emerald-700';
        }
      } catch (error: unknown) {
        console.error('NIP-65 import failed:', error);
        if (nip65Status) {
          nip65Status.textContent = 'Failed to import from NIP-65.';
          nip65Status.className = 'text-xs text-red-700';
        }
      } finally {
        nip65ImportButton.disabled = false;
        nip65ImportButton.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    });
  }

  if (nip65PublishButton) {
    nip65PublishButton.addEventListener('click', async (): Promise<void> => {
      if (!options.onNip65PublishRequested) {
        return;
      }
      nip65PublishButton.disabled = true;
      nip65PublishButton.classList.add('opacity-60', 'cursor-not-allowed');
      if (nip65Status) {
        nip65Status.textContent = 'Publishing NIP-65 relay list...';
        nip65Status.className = 'text-xs text-gray-600';
      }
      try {
        await options.onNip65PublishRequested();
        if (nip65Status) {
          nip65Status.textContent = 'Published NIP-65 relay list.';
          nip65Status.className = 'text-xs text-emerald-700';
        }
      } catch (error: unknown) {
        console.error('NIP-65 publish failed:', error);
        if (nip65Status) {
          nip65Status.textContent = 'Failed to publish NIP-65 relay list.';
          nip65Status.className = 'text-xs text-red-700';
        }
      } finally {
        nip65PublishButton.disabled = false;
        nip65PublishButton.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    });
  }

  renderRelayList();
}

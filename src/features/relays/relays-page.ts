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
    postsHeader.textContent = 'Relay Management';
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
          Manage the relays used for fetching profiles and timelines. Changes are saved in your browser.
        </div>
        <div class="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 text-xs">
          When you add a new relay, use Broadcast to re-send your recent posts to it.
        </div>
        <div class="bg-slate-50 border border-slate-200 text-slate-900 rounded-lg p-3 text-xs space-y-2">
          <div class="font-semibold">NIP-65 (kind 10002) Relay List</div>
          <div class="text-slate-700">
            You can publish your relay list to the network so other clients can discover it, or import it back into this app.
          </div>
          <div class="flex flex-col sm:flex-row gap-2">
            <button id="nip65-import"
              class="bg-slate-800 hover:bg-slate-900 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
              Import From NIP-65
            </button>
            <button id="nip65-publish"
              class="bg-indigo-700 hover:bg-indigo-800 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
              Publish NIP-65
            </button>
            <span class="text-xs text-gray-500 self-center">Requires sign-in for publishing.</span>
          </div>
          <p id="nip65-status" class="text-xs text-gray-600"></p>
        </div>
        <div class="flex flex-col sm:flex-row gap-2">
          <input id="relay-input" type="text" placeholder="wss://relay.example.com"
            class="border border-gray-300 rounded-lg px-4 py-2 flex-1 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button id="relay-add"
            class="bg-gradient-to-r from-slate-800 via-indigo-900 to-purple-950 hover:from-slate-900 hover:via-indigo-950 hover:to-purple-950 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow-lg">
            +
          </button>
        </div>
        <p id="relay-error" class="text-sm text-red-600"></p>
        <div class="flex flex-col sm:flex-row gap-2">
          <button id="broadcast-posts"
            class="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
            Broadcast Posts
          </button>
          <span class="text-xs text-gray-500 self-center">Re-send your recent posts to all relays.</span>
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
      row.className =
        'flex items-center justify-between gap-3 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2';

      const urlText: HTMLSpanElement = document.createElement('span');
      urlText.className =
        'font-mono text-xs sm:text-sm text-gray-800 break-all';
      urlText.textContent = relayUrl;

      const status: HTMLSpanElement = document.createElement('span');
      status.className =
        'text-xs font-semibold px-2 py-1 rounded-full bg-gray-200 text-gray-700';
      status.textContent = 'Checking...';

      const actions: HTMLDivElement = document.createElement('div');
      actions.className = 'flex gap-2 items-center';

      const upBtn: HTMLButtonElement = document.createElement('button');
      upBtn.className =
        'px-3 py-1 text-xs font-semibold rounded bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors';
      upBtn.textContent = '↑';
      upBtn.title = 'Move up';
      upBtn.setAttribute('aria-label', 'Move relay up');
      upBtn.disabled = index === 0;
      if (upBtn.disabled) {
        upBtn.classList.add('opacity-60', 'cursor-not-allowed');
      }
      upBtn.addEventListener('click', (): void => {
        clearError();
        if (index <= 0) return;
        const reordered: string[] = [...currentRelays];
        const above: string | undefined = reordered[index - 1];
        const current: string | undefined = reordered[index];
        if (!above || !current) return;
        reordered[index - 1] = current;
        reordered[index] = above;
        currentRelays = reordered;
        options.setRelays(currentRelays);
        options.onRelaysChanged();
        renderRelayList();
      });

      const downBtn: HTMLButtonElement = document.createElement('button');
      downBtn.className =
        'px-3 py-1 text-xs font-semibold rounded bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors';
      downBtn.textContent = '↓';
      downBtn.title = 'Move down';
      downBtn.setAttribute('aria-label', 'Move relay down');
      downBtn.disabled = index === currentRelays.length - 1;
      if (downBtn.disabled) {
        downBtn.classList.add('opacity-60', 'cursor-not-allowed');
      }
      downBtn.addEventListener('click', (): void => {
        clearError();
        if (index >= currentRelays.length - 1) return;
        const reordered: string[] = [...currentRelays];
        const below: string | undefined = reordered[index + 1];
        const current: string | undefined = reordered[index];
        if (!below || !current) return;
        reordered[index + 1] = current;
        reordered[index] = below;
        currentRelays = reordered;
        options.setRelays(currentRelays);
        options.onRelaysChanged();
        renderRelayList();
      });

      const editBtn: HTMLButtonElement = document.createElement('button');
      editBtn.className =
        'px-3 py-1 text-xs font-semibold rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit relay';
      editBtn.setAttribute('aria-label', 'Edit relay');
      editBtn.addEventListener('click', (): void => {
        clearError();
        const updatedRaw: string | null = window.prompt(
          'Edit relay URL:',
          relayUrl,
        );
        if (updatedRaw === null) return;
        const normalized: string | null = options.normalizeRelayUrl(updatedRaw);
        if (!normalized) {
          setError('Invalid relay URL. Use ws:// or wss://');
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
      });

      const deleteBtn: HTMLButtonElement = document.createElement('button');
      deleteBtn.className =
        'px-3 py-1 text-xs font-semibold rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors';
      deleteBtn.textContent = '🗑';
      deleteBtn.title = 'Delete relay';
      deleteBtn.setAttribute('aria-label', 'Delete relay');
      deleteBtn.addEventListener('click', (): void => {
        clearError();
        currentRelays = currentRelays.filter(
          (_: string, i: number): boolean => i !== index,
        );
        options.setRelays(currentRelays);
        options.onRelaysChanged();
        renderRelayList();
      });

      actions.appendChild(status);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(urlText);
      row.appendChild(actions);
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
        setError('Invalid relay URL. Use ws:// or wss://');
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

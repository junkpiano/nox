/**
 * Messages tab: conversation list and thread view.
 *
 * Both live in one module because they are one screen with two states, and the
 * thread has to be able to drop straight back to the list.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../../types/nostr';
import type { SetActiveNavFn } from '../../common/types.js';
import type { Conversation, StoredMessage } from './messages-store.js';
import {
  getConversation,
  getConversations,
  loadCachedMessages,
} from './messages-store.js';
import { sendDirectMessage, startMessageSync } from './messages-sync.js';
import { canUseDirectMessages } from './nip17.js';

interface MessagesPageOptions {
  closeAllWebSockets: () => void;
  stopBackgroundFetch: () => void;
  clearNotification: () => void;
  setActiveNav: SetActiveNavFn;
  output: HTMLElement | null;
  profileSection: HTMLElement | null;
  getRelays: () => string[];
}

/** Which conversation is open, or null for the list. */
let openPeer: PubkeyHex | null = null;

function shortPeer(pubkey: PubkeyHex): string {
  try {
    const npub: string = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
  } catch {
    return `${pubkey.slice(0, 12)}…`;
  }
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

function renderUnavailable(output: HTMLElement): void {
  output.innerHTML = `
    <section class="nox-panel p-4 text-sm">
      <h3 class="mb-2 font-semibold">Messages need a signing key</h3>
      <p>
        Private messages are encrypted to your key. Sign in with a private key,
        or use an extension that supports NIP-44, to read and send them.
      </p>
    </section>
  `;
}

function renderConversationList(
  output: HTMLElement,
  options: MessagesPageOptions,
): void {
  const conversations: Conversation[] = getConversations();

  if (conversations.length === 0) {
    output.innerHTML = `
      <section class="nox-panel p-4 text-sm">
        <h3 class="mb-2 font-semibold">No messages yet</h3>
        <p>
          Messages sent to you appear here. They are end-to-end encrypted, and
          relays cannot see who you are talking to.
        </p>
      </section>
    `;
    return;
  }

  output.innerHTML =
    '<div id="dm-list" class="divide-y divide-white/10"></div>';
  const list = output.querySelector('#dm-list');
  if (!list) {
    return;
  }

  for (const conversation of conversations) {
    const row: HTMLButtonElement = document.createElement('button');
    row.type = 'button';
    row.className = 'w-full px-1 py-3 text-left';

    const head: HTMLDivElement = document.createElement('div');
    head.className = 'flex items-baseline justify-between gap-3';

    const name: HTMLSpanElement = document.createElement('span');
    name.className = 'font-semibold';
    name.textContent = shortPeer(conversation.peer);

    const time: HTMLSpanElement = document.createElement('span');
    time.className = 'flex-none text-xs opacity-70';
    time.textContent = formatTime(conversation.lastMessage.createdAt);

    const preview: HTMLDivElement = document.createElement('div');
    preview.className = 'mt-1 truncate text-sm opacity-80';
    // Assigned as text: message content is untrusted input.
    preview.textContent = conversation.lastMessage.content;

    head.append(name, time);
    row.append(head, preview);
    row.addEventListener('click', (): void => {
      openPeer = conversation.peer;
      render(options);
    });
    list.appendChild(row);
  }
}

function renderThread(
  output: HTMLElement,
  peer: PubkeyHex,
  viewerPubkey: PubkeyHex,
  options: MessagesPageOptions,
): void {
  output.innerHTML = `
    <div class="space-y-3">
      <button id="dm-back" type="button" class="nox-muted-button rounded px-3 py-1 text-sm font-semibold">
        ← Conversations
      </button>
      <p id="dm-peer" class="break-all font-mono text-xs opacity-70"></p>
      <div id="dm-thread" class="space-y-2"></div>
      <div class="flex gap-2">
        <input
          id="dm-input"
          type="text"
          placeholder="Message"
          class="nox-input flex-1 rounded p-2 text-sm"
        />
        <button id="dm-send" type="button" class="nox-primary-button flex-none rounded px-4 py-2 font-semibold">
          Send
        </button>
      </div>
      <p id="dm-status" class="text-sm" role="status"></p>
    </div>
  `;

  const peerEl = output.querySelector('#dm-peer');
  if (peerEl) {
    peerEl.textContent = shortPeer(peer);
  }

  const thread = output.querySelector('#dm-thread');
  if (thread) {
    for (const message of getConversation(peer)) {
      const mine: boolean = message.author === viewerPubkey;
      const bubble: HTMLDivElement = document.createElement('div');
      bubble.className = mine
        ? 'ml-auto max-w-[80%] rounded-lg px-3 py-2 text-sm bg-indigo-600/40'
        : 'mr-auto max-w-[80%] rounded-lg px-3 py-2 text-sm bg-white/10';
      bubble.textContent = message.content;

      const stamp: HTMLDivElement = document.createElement('div');
      stamp.className = 'mt-1 text-[10px] opacity-60';
      stamp.textContent = formatTime(message.createdAt);
      bubble.appendChild(stamp);

      thread.appendChild(bubble);
    }
  }

  output.querySelector('#dm-back')?.addEventListener('click', (): void => {
    openPeer = null;
    render(options);
  });

  const input = output.querySelector('#dm-input') as HTMLInputElement | null;
  const sendButton = output.querySelector(
    '#dm-send',
  ) as HTMLButtonElement | null;
  const status = output.querySelector('#dm-status');

  const send = (): void => {
    void (async (): Promise<void> => {
      const text: string = input?.value.trim() ?? '';
      if (!text || !sendButton) {
        return;
      }

      sendButton.disabled = true;
      sendButton.classList.add('opacity-60', 'cursor-not-allowed');
      try {
        await sendDirectMessage({
          senderPubkey: viewerPubkey,
          recipientPubkey: peer,
          message: text,
          relays: options.getRelays(),
        });
        if (input) input.value = '';
      } catch (error: unknown) {
        if (status) {
          status.textContent =
            error instanceof Error
              ? `Could not send: ${error.message}`
              : 'Could not send the message.';
        }
      } finally {
        sendButton.disabled = false;
        sendButton.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    })();
  };

  sendButton?.addEventListener('click', send);
  input?.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      send();
    }
  });
}

function getViewerPubkey(): PubkeyHex | null {
  try {
    const stored: string | null = localStorage.getItem('nostr_pubkey');
    return stored ? (stored as PubkeyHex) : null;
  } catch {
    return null;
  }
}

function render(options: MessagesPageOptions): void {
  const output: HTMLElement | null = options.output;
  const viewerPubkey: PubkeyHex | null = getViewerPubkey();
  if (!output || !viewerPubkey) {
    return;
  }

  if (openPeer) {
    renderThread(output, openPeer, viewerPubkey, options);
  } else {
    renderConversationList(output, options);
  }
}

export function loadMessagesPage(options: MessagesPageOptions): void {
  options.closeAllWebSockets();
  options.stopBackgroundFetch();
  options.clearNotification();

  options.setActiveNav(
    document.getElementById('nav-home'),
    document.getElementById('nav-global'),
    document.getElementById('nav-relays'),
    document.getElementById('nav-profile'),
    document.getElementById('nav-settings'),
    null,
  );

  const postsHeader: HTMLElement | null =
    document.getElementById('posts-header');
  if (postsHeader) {
    postsHeader.textContent = 'Messages';
    postsHeader.style.display = '';
  }

  if (options.profileSection) {
    options.profileSection.innerHTML = '';
    options.profileSection.className = '';
  }

  const output: HTMLElement | null = options.output;
  if (!output) {
    return;
  }

  const viewerPubkey: PubkeyHex | null = getViewerPubkey();
  if (!viewerPubkey) {
    output.innerHTML =
      '<section class="nox-panel p-4 text-sm">Sign in to use messages.</section>';
    return;
  }
  if (!canUseDirectMessages()) {
    renderUnavailable(output);
    return;
  }

  // Always start on the list: arriving at a thread left open from a previous
  // visit would be disorienting.
  openPeer = null;

  void (async (): Promise<void> => {
    await loadCachedMessages();
    render(options);
    // Cached history renders first; the relay backfill fills in behind it.
    await startMessageSync(viewerPubkey, options.getRelays());
  })();

  window.addEventListener('dm-messages-updated', (): void => {
    // Only repaint while this page is still the one on screen.
    if (document.getElementById('posts-header')?.textContent === 'Messages') {
      render(options);
    }
  });
}

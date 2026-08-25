/**
 * Messages tab: conversation list and thread view.
 *
 * Both live in one module because they are one screen with two states, and the
 * thread has to be able to drop straight back to the list.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../../types/nostr';
import type { SetActiveNavFn } from '../../common/types.js';
import {
  fetchDmRelayList,
  fetchNip65ReadRelays,
  invalidateDmRelayCache,
  signDmRelayListEvent,
} from './dm-relays.js';
import type { Conversation, StoredMessage } from './messages-store.js';
import {
  getConversation,
  getConversations,
  loadCachedMessages,
} from './messages-store.js';
import { sendDirectMessage, startMessageSync } from './messages-sync.js';
import { canUseDirectMessages } from './nip17.js';
import { resolveRecipient } from './resolve-recipient.js';

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

/** True while picking a recipient for a conversation that does not exist yet. */
let composing: boolean = false;

/**
 * Set by other pages to open a conversation on arrival.
 *
 * The profile page uses this so "Message" lands in the right thread instead of
 * making the user find the person again.
 */
let pendingPeer: PubkeyHex | null = null;

export function openConversationWith(peer: PubkeyHex): void {
  pendingPeer = peer;
}

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

/**
 * Prompts the user to publish a DM relay list when they have none.
 *
 * Without kind 10050 nobody can message them: other clients refuse to guess
 * where to deliver, and say so. Amethyst reports "cannot deliver until the
 * recipient sets a relay list" and stops. This is therefore a setup step, not
 * an optional refinement, and belongs at the top of the screen until done.
 */
async function renderDmRelayNotice(
  output: HTMLElement,
  viewerPubkey: PubkeyHex,
  options: MessagesPageOptions,
): Promise<void> {
  const relays: string[] = options.getRelays();
  const published: string[] = await fetchDmRelayList(viewerPubkey, relays);
  if (published.length > 0) {
    return;
  }

  const notice: HTMLElement = document.createElement('section');
  notice.className = 'nox-panel mb-3 p-4 text-sm';
  notice.innerHTML = `
    <h3 class="mb-2 font-semibold">Nobody can message you yet</h3>
    <p class="mb-3">
      Other clients need to know which relays to deliver your private messages
      to. Until you publish that list they will refuse to send, and you will
      not receive anything.
    </p>
    <p id="dm-relay-status" class="mb-3 text-xs opacity-80"></p>
    <button id="dm-relay-publish" type="button" class="nox-primary-button w-full rounded px-4 py-2 font-semibold">
      Publish my DM relays
    </button>
  `;
  output.prepend(notice);

  const status = notice.querySelector('#dm-relay-status');
  if (status) {
    status.textContent = `Will publish: ${relays.join(', ')}`;
  }

  const button = notice.querySelector(
    '#dm-relay-publish',
  ) as HTMLButtonElement | null;
  button?.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      button.disabled = true;
      button.classList.add('opacity-60', 'cursor-not-allowed');
      if (status) status.textContent = 'Publishing…';
      try {
        const event = await signDmRelayListEvent({
          pubkeyHex: viewerPubkey,
          relayUrls: relays,
        });
        const { publishEventToRelays } = await import('../profile/follow.js');
        await publishEventToRelays(event, relays);
        invalidateDmRelayCache(viewerPubkey);
        notice.remove();
      } catch (error: unknown) {
        if (status) {
          status.textContent =
            error instanceof Error
              ? `Could not publish: ${error.message}`
              : 'Could not publish the list.';
        }
        button.disabled = false;
        button.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    })();
  });
}

function wireNewMessage(
  output: HTMLElement,
  options: MessagesPageOptions,
): void {
  output.querySelector('#dm-new')?.addEventListener('click', (): void => {
    composing = true;
    render(options);
  });
}

function renderConversationList(
  output: HTMLElement,
  options: MessagesPageOptions,
): void {
  const conversations: Conversation[] = getConversations();

  // The new-message button is rendered in both states: with no conversations
  // yet, it is the only way in, and an empty screen with no action is a dead
  // end.
  const startButtonHtml: string = `
    <button id="dm-new" type="button" class="nox-primary-button w-full rounded px-4 py-2 font-semibold">
      New message
    </button>
  `;

  if (conversations.length === 0) {
    output.innerHTML = `
      <div class="space-y-3">
        <section class="nox-panel p-4 text-sm">
          <h3 class="mb-2 font-semibold">No messages yet</h3>
          <p>
            Messages sent to you appear here. They are end-to-end encrypted, and
            relays cannot see who you are talking to.
          </p>
        </section>
        ${startButtonHtml}
      </div>
    `;
    wireNewMessage(output, options);
    return;
  }

  output.innerHTML = `
    <div class="space-y-3">
      ${startButtonHtml}
      <div id="dm-list" class="divide-y divide-white/10"></div>
    </div>
  `;
  wireNewMessage(output, options);

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

function renderCompose(
  output: HTMLElement,
  options: MessagesPageOptions,
): void {
  output.innerHTML = `
    <div class="space-y-3">
      <button id="dm-cancel" type="button" class="nox-muted-button rounded px-3 py-1 text-sm font-semibold">
        ← Conversations
      </button>
      <label class="nox-field-label" for="dm-to">To</label>
      <input
        id="dm-to"
        type="text"
        spellcheck="false"
        placeholder="npub1… or user@example.com"
        class="nox-input w-full rounded p-2 text-sm"
      />
      <p id="dm-compose-status" class="text-sm" role="status"></p>
      <button id="dm-start" type="button" class="nox-primary-button w-full rounded px-4 py-2 font-semibold">
        Start conversation
      </button>
    </div>
  `;

  output.querySelector('#dm-cancel')?.addEventListener('click', (): void => {
    composing = false;
    render(options);
  });

  const input = output.querySelector('#dm-to') as HTMLInputElement | null;
  const startButton = output.querySelector(
    '#dm-start',
  ) as HTMLButtonElement | null;
  const status = output.querySelector('#dm-compose-status');

  const start = (): void => {
    void (async (): Promise<void> => {
      if (!startButton) {
        return;
      }
      startButton.disabled = true;
      startButton.classList.add('opacity-60', 'cursor-not-allowed');
      if (status) status.textContent = '';

      try {
        // Resolved before opening the thread, so a bad address fails here
        // rather than on the first message.
        const peer: PubkeyHex = await resolveRecipient(input?.value ?? '');
        composing = false;
        openPeer = peer;
        render(options);
      } catch (error: unknown) {
        if (status) {
          status.textContent =
            error instanceof Error
              ? error.message
              : 'Could not find that user.';
        }
        startButton.disabled = false;
        startButton.classList.remove('opacity-60', 'cursor-not-allowed');
      }
    })();
  };

  startButton?.addEventListener('click', start);
  input?.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      start();
    }
  });
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
      <p id="dm-peer-warning" class="text-xs text-amber-300" role="status"></p>
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

  // Checked on open rather than only after sending, so the warning arrives
  // before the message does.
  void (async (): Promise<void> => {
    const recipientRelays: string[] = await fetchDmRelayList(
      peer,
      options.getRelays(),
    );
    if (recipientRelays.length > 0) {
      return;
    }
    const readRelays: string[] = await fetchNip65ReadRelays(
      peer,
      options.getRelays(),
    );
    const warning = output.querySelector('#dm-peer-warning');
    if (warning) {
      warning.textContent =
        readRelays.length > 0
          ? 'This account has not set up private messaging. Messages will go to their public relays, which may not reach them.'
          : 'This account publishes no relays. Messages to them may never arrive.';
    }
  })();

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
        const result = await sendDirectMessage({
          senderPubkey: viewerPubkey,
          recipientPubkey: peer,
          message: text,
          relays: options.getRelays(),
        });
        if (input) input.value = '';
        if (status) {
          // "Sent" and "sent where they will see it" are different claims, and
          // conflating them is what makes a silent non-delivery baffling.
          if (!result.deliveredToRecipientRelays) {
            status.textContent =
              'Sent, but this account publishes no relays at all. It may never arrive.';
          } else if (result.usedFallback) {
            status.textContent =
              'Sent. This account has not set up private messaging, so delivery used their public relays and is not guaranteed.';
          } else {
            status.textContent = '';
          }
        }
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

  if (composing) {
    renderCompose(output, options);
  } else if (openPeer) {
    renderThread(output, openPeer, viewerPubkey, options);
  } else {
    renderConversationList(output, options);
    void renderDmRelayNotice(output, viewerPubkey, options);
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

  // Start on the list unless another page asked for a specific conversation.
  // Arriving at a thread left open from a previous visit would be disorienting,
  // but arriving where the user just asked to go is the whole point.
  openPeer = pendingPeer;
  pendingPeer = null;
  composing = false;

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

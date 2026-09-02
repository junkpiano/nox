import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import {
  fetchFollowList,
  fetchLatestFollowListEvent,
  lookupFollowList,
} from '../../common/events-queries.js';
import { isMuted } from '../../common/mute-state.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getSessionPrivateKey } from '../../common/session.js';
import { recordRelayFailure } from '../relays/relays.js';
import { nextFollowListTags } from './follow-list.js';

interface FollowToggleOptions {
  getRelays: () => string[];
  publishEvent: (event: NostrEvent, relayList: string[]) => Promise<void>;
  onFollowListChanged?: () => void;
}

export async function setupFollowToggle(
  targetPubkey: PubkeyHex,
  options: FollowToggleOptions,
): Promise<void> {
  const container: HTMLElement | null =
    document.getElementById('follow-action');
  if (!container) return;

  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');
  if (!storedPubkey || storedPubkey === targetPubkey) {
    container.innerHTML = '';
    return;
  }

  // Follow keeps its label: it is the primary action and its state matters.
  // Message is a destination, not a decision, so an icon carries it.
  container.innerHTML = `
    <div class="flex flex-wrap items-center justify-center gap-2">
      <button id="follow-toggle" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow">
        Follow
      </button>
      <button id="profile-message" type="button" class="nox-muted-button rounded-lg p-2 transition-colors" aria-label="Message" title="Message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5 block" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 7l9 6 9-6" />
          <rect x="3" y="5" width="18" height="14" rx="2" />
        </svg>
      </button>
      <button id="profile-mute-toggle" type="button" class="nox-muted-button font-semibold py-2 px-4 rounded-lg transition-colors">
        ${isMuted(targetPubkey) ? 'Unmute' : 'Mute'}
      </button>
      <button id="profile-report" type="button" class="nox-muted-button font-semibold py-2 px-4 rounded-lg transition-colors">
        Report
      </button>
    </div>
  `;

  document
    .getElementById('profile-message')
    ?.addEventListener('click', (): void => {
      void (async (): Promise<void> => {
        // Imported on demand: the messages module is lazy-loaded, and a profile
        // view should not pull it in just to render a button.
        const { openConversationWith } = await import(
          '../messages/messages-page.js'
        );
        openConversationWith(targetPubkey);
        window.dispatchEvent(
          new CustomEvent('navigate-to-path', {
            detail: { path: '/messages' },
          }),
        );
      })();
    });

  document
    .getElementById('profile-mute-toggle')
    ?.addEventListener('click', (): void => {
      window.dispatchEvent(
        new CustomEvent('request-mute-user', {
          detail: { pubkey: targetPubkey, name: '' },
        }),
      );
    });

  document
    .getElementById('profile-report')
    ?.addEventListener('click', (): void => {
      window.dispatchEvent(
        new CustomEvent('request-report-content', {
          detail: { pubkey: targetPubkey, name: '' },
        }),
      );
    });

  const button: HTMLButtonElement | null = document.getElementById(
    'follow-toggle',
  ) as HTMLButtonElement;
  if (!button) return;

  const hasSigningCapability = (): boolean => {
    const hasExtension: boolean = Boolean((window as any).nostr?.signEvent);
    const hasPrivateKey: boolean = Boolean(getSessionPrivateKey());
    return hasExtension || hasPrivateKey;
  };

  let isFollowing: boolean = false;
  let followList: PubkeyHex[] = [];

  try {
    followList = await fetchFollowList(
      storedPubkey as PubkeyHex,
      options.getRelays(),
    );
    isFollowing = followList.includes(targetPubkey);
  } catch (e) {
    console.warn('Failed to load follow list for toggle', e);
  }

  const updateButton = (): void => {
    if (!hasSigningCapability()) {
      button.textContent = 'Follow (sign-in required)';
      button.className =
        'bg-slate-500 hover:bg-slate-600 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow';
      return;
    }

    if (isFollowing) {
      button.textContent = 'Unfollow';
      button.className =
        'bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow';
    } else {
      button.textContent = 'Follow';
      button.className =
        'bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors shadow';
    }
  };

  updateButton();

  button.addEventListener('click', async (): Promise<void> => {
    if (!hasSigningCapability()) {
      alert(
        'Sign-in required to follow. Please log in with extension or private key.',
      );
      return;
    }

    button.disabled = true;
    button.classList.add('opacity-60', 'cursor-not-allowed');

    try {
      // Fetch the full current kind-3 so we can mutate it in place, preserving
      // petnames/relay hints on existing `p` tags, any non-`p` tags, and the
      // legacy relay JSON in `content`.
      // Every relay gets its say here: the list published next replaces
      // whatever the slowest relay was holding.
      const lookup = await lookupFollowList(
        storedPubkey as PubkeyHex,
        options.getRelays(),
        { waitForAll: true },
      );
      const currentEvent: NostrEvent | null = lookup.event;

      // The rules for editing a kind 3 without destroying it live in
      // follow-list.ts, shared with the native app and covered by tests. A
      // null event throws there, for the reason it always did: every relay
      // failing looks exactly like "you follow nobody", and publishing the
      // second reading would wipe the first one's follows network-wide.
      const tags: string[][] = nextFollowListTags(
        lookup,
        targetPubkey,
        !isFollowing,
      );

      const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: 3,
        pubkey: storedPubkey as PubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        // Carried over untouched: some clients still keep a relay list in here
        // as JSON, and this one does not understand it well enough to rewrite.
        content: currentEvent?.content ?? '',
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
      await options.publishEvent(signedEvent, options.getRelays());

      isFollowing = !isFollowing;
      updateButton();
      if (options.onFollowListChanged) {
        options.onFollowListChanged();
      }
    } catch (error: unknown) {
      console.error('Failed to update follow list:', error);
      alert('Failed to update follow list. Please try again.');
    } finally {
      button.disabled = false;
      button.classList.remove('opacity-60', 'cursor-not-allowed');
    }
  });
}

// Moved to common/publish-event.ts, which does not import the DOM, and
// re-exported so the eight modules importing it from here still work.
export { publishEventToRelays } from '../../common/publish-event.js';

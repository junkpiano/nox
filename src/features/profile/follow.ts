import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import {
  fetchFollowList,
  fetchLatestFollowListEvent,
} from '../../common/events-queries.js';
import { createMoreMenu } from '../../common/more-menu.js';
import { isMuted } from '../../common/mute-state.js';
import { createRelayWebSocket } from '../../common/relay-socket.js';
import { getSessionPrivateKey } from '../../common/session.js';
import { canWrite, signWithSession } from '../../common/signer.js';
import { recordRelayFailure } from '../relays/relays.js';

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
  if (!canWrite()) {
    // Disabled rather than gone: the button is where the person learns
    // what signing in would let them do here.
    container.innerHTML = `
      <div class="nox-profile-action-row">
        <button id="follow-toggle" type="button" aria-disabled="true" title="Sign in to follow"
          class="nox-secondary-button py-2 px-5 text-sm opacity-60 cursor-not-allowed">
          Follow
        </button>
      </div>
    `;
    document
      .getElementById('follow-toggle')
      ?.addEventListener('click', (): void => {
        alert('Sign in to follow.');
      });
    return;
  }

  // Follow is the one decision on the page and the one filled button. The
  // rest - a message, a mute, a report - are rare, and live behind one
  // quiet mark rather than sharing the row as equals.
  container.innerHTML = `
    <div class="nox-profile-action-row">
      <button id="follow-toggle" class="nox-primary-button py-2 px-5 text-sm">
        Follow
      </button>
    </div>
  `;
  container.querySelector('.nox-profile-action-row')?.appendChild(
    createMoreMenu({
      label: 'More actions for this person',
      items: [
        {
          label: 'Message',
          onSelect: (): void => {
            void (async (): Promise<void> => {
              // Imported on demand: the messages module is lazy-loaded, and
              // a profile view should not pull it in just to render a button.
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
          },
        },
        {
          label: isMuted(targetPubkey) ? 'Unmute' : 'Mute',
          onSelect: (): void => {
            window.dispatchEvent(
              new CustomEvent('request-mute-user', {
                detail: { pubkey: targetPubkey, name: '' },
              }),
            );
          },
        },
        {
          label: 'Report',
          danger: true,
          onSelect: (): void => {
            window.dispatchEvent(
              new CustomEvent('request-report-content', {
                detail: { pubkey: targetPubkey, name: '' },
              }),
            );
          },
        },
      ],
    }),
  );

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
      const currentEvent: NostrEvent | null = await fetchLatestFollowListEvent(
        storedPubkey as PubkeyHex,
        options.getRelays(),
        { waitForAll: true },
      );

      // A null result means every relay failed or returned nothing — we do NOT
      // know the real follow list. Publishing here would broadcast a list built
      // from scratch and wipe the user's follows network-wide. Abort instead.
      if (!currentEvent) {
        throw new Error(
          'Could not load your current follow list from any relay; not modifying it to avoid wiping your follows.',
        );
      }

      const existingTags: string[][] = currentEvent.tags;
      const alreadyFollowing: boolean = existingTags.some(
        (tag: string[]): boolean => tag[0] === 'p' && tag[1] === targetPubkey,
      );

      let tags: string[][];
      if (isFollowing) {
        // Unfollow: drop only the target's `p` tag, keep everything else intact.
        tags = existingTags.filter(
          (tag: string[]): boolean =>
            !(tag[0] === 'p' && tag[1] === targetPubkey),
        );
      } else {
        // Follow: append the target unless it's somehow already present.
        tags = alreadyFollowing
          ? existingTags
          : [...existingTags, ['p', targetPubkey]];
      }

      const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
        kind: 3,
        pubkey: storedPubkey as PubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: currentEvent.content,
      };

      const signedEvent: NostrEvent = await signWithSession(unsignedEvent);
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

export async function publishEventToRelays(
  event: NostrEvent,
  relayList: string[],
): Promise<void> {
  const promises = relayList.map(async (relayUrl: string): Promise<void> => {
    try {
      const socket: WebSocket = createRelayWebSocket(relayUrl);
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          recordRelayFailure(relayUrl);
          socket.close();
          resolve();
        }, 5000);

        socket.onopen = (): void => {
          socket.send(JSON.stringify(['EVENT', event]));
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
      console.warn(`Failed to publish event to ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);
}

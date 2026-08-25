/**
 * Fetching and sending direct messages.
 *
 * Gift wraps carry no hint of who is inside them, so the only usable filter is
 * "wraps addressed to me". Everything else has to be decrypted to find out what
 * it is, which is why results are cached rather than re-derived.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { openRelaySubscription } from '../../common/relay-socket.js';
import { publishEventToRelays } from '../profile/follow.js';
import { addMessages } from './messages-store.js';
import type { ChatRumor } from './nip17.js';
import { buildGiftWraps, GIFT_WRAP_KIND, unwrapChatMessage } from './nip17.js';

/**
 * Wraps are timestamped up to two days in the past to hide when a conversation
 * happened, so a window based on "now" has to reach back further than the
 * period actually being caught up on.
 */
const LOOKBACK_SECONDS: number = 60 * 60 * 24 * 30;

let activeUnsubscribers: Array<() => void> = [];

/** Decrypts in the background so a batch cannot block the UI thread. */
async function ingest(
  wraps: NostrEvent[],
  viewerPubkey: PubkeyHex,
): Promise<void> {
  const rumors: ChatRumor[] = [];
  for (const wrap of wraps) {
    const rumor: ChatRumor | null = await unwrapChatMessage(wrap);
    if (rumor) {
      rumors.push(rumor);
    }
  }
  if (rumors.length > 0) {
    addMessages(rumors, viewerPubkey);
  }
}

/**
 * Subscribes to incoming gift wraps across the configured relays.
 *
 * Returns a teardown that closes every subscription, so route changes do not
 * leave listeners behind.
 */
export async function startMessageSync(
  viewerPubkey: PubkeyHex,
  relays: string[],
): Promise<() => void> {
  stopMessageSync();

  const since: number = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
  const pending: NostrEvent[] = [];
  let flushTimer: number | null = null;

  // Decryption is expensive per event, so wraps are batched rather than
  // handled one at a time during the initial backfill.
  const scheduleFlush = (): void => {
    if (flushTimer !== null) {
      return;
    }
    flushTimer = window.setTimeout((): void => {
      flushTimer = null;
      const batch: NostrEvent[] = pending.splice(0, pending.length);
      void ingest(batch, viewerPubkey);
    }, 250);
  };

  const unsubscribers: Array<() => void> = [];
  await Promise.allSettled(
    relays.map(async (relayUrl: string): Promise<void> => {
      try {
        const unsubscribe = await openRelaySubscription(
          relayUrl,
          {
            kinds: [GIFT_WRAP_KIND],
            '#p': [viewerPubkey],
            since,
            limit: 500,
          },
          {
            onEvent: (event: NostrEvent): void => {
              pending.push(event);
              scheduleFlush();
            },
          },
        );
        unsubscribers.push(unsubscribe);
      } catch (error: unknown) {
        console.warn(`[dm] Failed to subscribe on ${relayUrl}:`, error);
      }
    }),
  );

  activeUnsubscribers = unsubscribers;
  return stopMessageSync;
}

export function stopMessageSync(): void {
  for (const unsubscribe of activeUnsubscribers) {
    try {
      unsubscribe();
    } catch {
      // Already torn down.
    }
  }
  activeUnsubscribers = [];
}

/**
 * Sends a message and records it locally.
 *
 * The sender's own copy is added straight away rather than waiting for it to
 * come back from a relay, so the thread updates immediately.
 */
export async function sendDirectMessage(params: {
  senderPubkey: PubkeyHex;
  recipientPubkey: PubkeyHex;
  message: string;
  relays: string[];
}): Promise<void> {
  const wraps: NostrEvent[] = await buildGiftWraps({
    senderPubkey: params.senderPubkey,
    recipientPubkey: params.recipientPubkey,
    message: params.message,
  });

  await Promise.all(
    wraps.map(
      (wrap: NostrEvent): Promise<void> =>
        publishEventToRelays(wrap, params.relays),
    ),
  );

  addMessages(
    [
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pubkey: params.senderPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 14,
        tags: [['p', params.recipientPubkey]],
        content: params.message,
      },
    ],
    params.senderPubkey,
  );
}

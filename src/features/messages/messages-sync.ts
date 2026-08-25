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
import {
  fetchDmRelayList,
  fetchNip65ReadRelays,
  resolveDeliveryRelays,
} from './dm-relays.js';
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

  // Listen wherever we advertised, or messages sent correctly by other
  // clients would land on relays this one never reads.
  const ownDmRelays: string[] = await fetchDmRelayList(viewerPubkey, relays);
  const listenRelays: string[] = Array.from(
    new Set([...relays, ...ownDmRelays]),
  );

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
    listenRelays.map(async (relayUrl: string): Promise<void> => {
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
/**
 * Whether the message could be delivered where the recipient actually reads.
 *
 * False means it went to this client's own relays as a guess, which is worth
 * telling the user about: it is the difference between "sent" and "sent
 * somewhere they may never look".
 */
export interface SendResult {
  deliveredToRecipientRelays: boolean;
  /** True when NIP-65 stood in for a missing DM relay list. */
  usedFallback: boolean;
}

export async function sendDirectMessage(params: {
  senderPubkey: PubkeyHex;
  recipientPubkey: PubkeyHex;
  message: string;
  relays: string[];
}): Promise<SendResult> {
  const wraps: NostrEvent[] = await buildGiftWraps({
    senderPubkey: params.senderPubkey,
    recipientPubkey: params.recipientPubkey,
    message: params.message,
  });

  // Each copy goes where its reader will look for it. A gift wrap left on
  // relays the recipient never reads is delivered nowhere, which is the whole
  // reason kind 10050 exists.
  const [recipientDmRelays, ownDmRelays] = await Promise.all([
    fetchDmRelayList(params.recipientPubkey, params.relays),
    fetchDmRelayList(params.senderPubkey, params.relays),
  ]);

  // Only worth a lookup when there is no DM list to honour.
  const recipientReadRelays: string[] =
    recipientDmRelays.length > 0
      ? []
      : await fetchNip65ReadRelays(params.recipientPubkey, params.relays);

  const recipientTargets: string[] = resolveDeliveryRelays(
    recipientDmRelays,
    params.relays,
    recipientReadRelays,
  );
  const ownTargets: string[] = resolveDeliveryRelays(
    ownDmRelays,
    params.relays,
  );

  // buildGiftWraps returns the recipient's copy first, then the sender's.
  const [recipientWrap, ownWrap] = wraps;
  await Promise.all([
    recipientWrap
      ? publishEventToRelays(recipientWrap, recipientTargets)
      : Promise.resolve(),
    ownWrap ? publishEventToRelays(ownWrap, ownTargets) : Promise.resolve(),
  ]);

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

  return {
    deliveredToRecipientRelays:
      recipientDmRelays.length > 0 || recipientReadRelays.length > 0,
    usedFallback: recipientDmRelays.length === 0,
  };
}

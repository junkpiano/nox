import { signWithSession } from '../../common/signer.js';
/**
 * NIP-17 kind 10050 DM relay lists.
 *
 * This list is how someone says "send my private messages here". Without one
 * published, other clients cannot tell where to deliver a message, and some
 * refuse to try at all — Amethyst reports "DM receive relay not found" and
 * stops. It is also how this client knows where to send: a gift wrap put on
 * relays the recipient never reads is delivered nowhere.
 *
 * Deliberately separate from NIP-65 (kind 10002). A DM relay list is usually
 * short and chosen for reliability rather than reach, and mixing the two would
 * scatter private messages across every relay someone happens to post to.
 */

import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { createRelayWebSocket } from '../../common/relay-socket.js';

export const DM_RELAY_LIST_KIND: number = 10050;
const NIP65_RELAY_LIST_KIND: number = 10002;

/** Cached per pubkey: sending a message should not refetch this every time. */
const cache: Map<PubkeyHex, string[]> = new Map();

function parseRelayTags(event: NostrEvent): string[] {
  const urls: string[] = [];
  for (const tag of event.tags) {
    if (
      Array.isArray(tag) &&
      tag[0] === 'relay' &&
      typeof tag[1] === 'string'
    ) {
      const url: string = tag[1].trim();
      if (url.startsWith('wss://') || url.startsWith('ws://')) {
        urls.push(url);
      }
    }
  }
  return urls;
}

/**
 * Reads someone's DM relay list.
 *
 * Returns an empty array when they have not published one, which is different
 * from a lookup failure only in that both leave the caller to fall back.
 */
async function fetchNewestEvent(
  kind: number,
  pubkey: PubkeyHex,
  searchRelays: string[],
): Promise<NostrEvent | null> {
  // Held in an object so the type survives the socket callbacks.
  const newest: { event: NostrEvent | null } = { event: null };

  await Promise.allSettled(
    searchRelays.map(async (relayUrl: string): Promise<void> => {
      try {
        const socket: WebSocket = createRelayWebSocket(relayUrl);
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              socket.close();
            } catch {
              // Already closing.
            }
            resolve();
          };
          const timer = setTimeout(finish, 5000);

          socket.onopen = (): void => {
            socket.send(
              JSON.stringify([
                'REQ',
                `dmr-${Math.random().toString(36).slice(2)}`,
                { kinds: [kind], authors: [pubkey], limit: 1 },
              ]),
            );
          };
          socket.onmessage = (message: MessageEvent): void => {
            try {
              const frame: unknown[] = JSON.parse(message.data);
              if (frame[0] === 'EVENT') {
                const event = frame[2] as NostrEvent;
                if (
                  event?.kind === kind &&
                  (!newest.event || event.created_at >= newest.event.created_at)
                ) {
                  newest.event = event;
                }
                return;
              }
              if (frame[0] === 'EOSE') {
                finish();
              }
            } catch {
              finish();
            }
          };
          socket.onerror = finish;
        });
      } catch {
        // One unreachable relay must not fail the lookup.
      }
    }),
  );

  return newest.event;
}

/**
 * Reads someone's DM relay list.
 *
 * Returns an empty array when they have not published one, which is different
 * from a lookup failure only in that both leave the caller to fall back.
 */
export async function fetchDmRelayList(
  pubkey: PubkeyHex,
  searchRelays: string[],
): Promise<string[]> {
  const cached: string[] | undefined = cache.get(pubkey);
  if (cached) {
    return cached;
  }

  const event: NostrEvent | null = await fetchNewestEvent(
    DM_RELAY_LIST_KIND,
    pubkey,
    searchRelays,
  );
  const urls: string[] = event ? parseRelayTags(event) : [];
  cache.set(pubkey, urls);
  return urls;
}

/** Drops a cached list, so a freshly published one is picked up. */
export function invalidateDmRelayCache(pubkey: PubkeyHex): void {
  cache.delete(pubkey);
}

export async function signDmRelayListEvent(params: {
  pubkeyHex: PubkeyHex;
  relayUrls: string[];
}): Promise<NostrEvent> {
  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: DM_RELAY_LIST_KIND,
    pubkey: params.pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: params.relayUrls.map((url: string): string[] => ['relay', url]),
    content: '',
  };

  return signWithSession(unsignedEvent);
}

/**
 * Reads the relays someone says they receive on, from NIP-65.
 *
 * Used only as a fallback when they have published no DM relay list. The
 * `read` marker is the one that matters here: it is where they look for things
 * addressed to them, which is exactly what a gift wrap is. An unmarked `r` tag
 * means both, so it counts too.
 */
export async function fetchNip65ReadRelays(
  pubkey: PubkeyHex,
  searchRelays: string[],
): Promise<string[]> {
  const event: NostrEvent | null = await fetchNewestEvent(
    NIP65_RELAY_LIST_KIND,
    pubkey,
    searchRelays,
  );
  if (!event) {
    return [];
  }

  const urls: string[] = [];
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'r' || typeof tag[1] !== 'string') {
      continue;
    }
    const marker: unknown = tag[2];
    if (marker === undefined || marker === '' || marker === 'read') {
      urls.push(tag[1].trim());
    }
  }
  return Array.from(new Set(urls));
}

/**
 * Chooses where to deliver a gift wrap.
 *
 * The recipient's own list wins, because it is the only statement of where
 * they actually read. Falling back to the sender's relays is a guess, but a
 * better one than not sending at all.
 */
export function resolveDeliveryRelays(
  recipientDmRelays: string[],
  ownRelays: string[],
  recipientReadRelays: string[] = [],
): string[] {
  if (recipientDmRelays.length > 0) {
    return Array.from(new Set(recipientDmRelays));
  }

  // No DM relay list. Their NIP-65 read relays are the next best statement of
  // where they look, and in practice the difference decides whether a message
  // arrives: two people with no relay in common never see each other's
  // messages, however correctly both clients behave.
  //
  // Own relays stay in the set so the message is still reachable from here.
  return Array.from(new Set([...recipientReadRelays, ...ownRelays]));
}

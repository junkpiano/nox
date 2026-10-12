/**
 * Sending a signed event to relays.
 *
 * This lived inside `follow.ts` - a module about a follow button, which
 * imports the DOM. Eight other modules import the helper from there, so
 * anything wanting to publish also had to drag a button's worth of browser in
 * with it, and the moderation code could not be used from React Native at all
 * for that reason alone.
 *
 * It is unchanged apart from its address; `follow.ts` re-exports it so every
 * existing importer keeps working.
 */

import type { NostrEvent } from '../../types/nostr';
import { recordRelayFailure } from '../features/relays/relays.js';
import { createRelayWebSocket } from './relay-socket.js';

export async function publishEventToRelays(
  event: NostrEvent,
  relayList: string[],
): Promise<void> {
  await publishAndCount(event, relayList);
}

/**
 * The same send, resolving with how many relays accepted the event (`OK`
 * true for this id). Most callers send and move on; one replacing a list
 * needs to know it landed somewhere.
 */
export async function publishAndCount(
  event: NostrEvent,
  relayList: string[],
): Promise<number> {
  let accepted: number = 0;
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
          // This event's answer only: a relay that asks for AUTH sends an
          // OK for that first, and closing on it drops the event unanswered.
          if (arr[0] === 'OK' && arr[1] === event.id) {
            if (arr[2] === true) accepted += 1;
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
  return accepted;
}

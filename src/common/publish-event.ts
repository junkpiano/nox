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

/**
 * Signing an event and getting it onto relays.
 *
 * The signing is shared: `getSessionPrivateKey()` reads the key that
 * `restoreSessionPrivateKey()` loaded out of the credential store at start-up,
 * and `finalizeEvent` is nostr-tools, already proven under Hermes. The client
 * tag comes from the shared allow-list, so a native post is tagged by the same
 * rule as a web one - and, just as importantly, a gift wrap still is not.
 *
 * What is written here is the delivery: which relays, and what counts as
 * having worked.
 */

import { finalizeEvent } from 'nostr-tools';

import type { NostrEvent } from '../../types/nostr';
import { withClientTag } from '../../src/common/client-tag';
import { createRelayWebSocket } from '../../src/common/relay-socket';
import { getSessionPrivateKey } from '../../src/common/session';
import { getRelays } from '../../src/features/relays/relays';

const PUBLISH_TIMEOUT_MS: number = 8000;

export interface PublishResult {
  event: NostrEvent;
  accepted: string[];
  rejected: Array<{ relay: string; reason: string }>;
}

export class NotSignedInError extends Error {
  constructor() {
    super('No key in this session. Sign in first.');
  }
}

/**
 * Sends a signed event to one relay and waits for its verdict.
 *
 * NIP-01 has the relay answer with OK plus a boolean, and a relay that never
 * answers is counted as a refusal rather than a success - claiming a post
 * landed when it may not have is worse than admitting the doubt.
 */
function publishTo(relayUrl: string, event: NostrEvent): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve(reason);
    };

    const timer = setTimeout((): void => finish('no answer'), PUBLISH_TIMEOUT_MS);

    let socket: WebSocket;
    try {
      socket = createRelayWebSocket(relayUrl, true);
    } catch (error: unknown) {
      resolve(String(error));
      return;
    }

    socket.onopen = (): void => {
      socket.send(JSON.stringify(['EVENT', event]));
    };

    socket.onmessage = (message: MessageEvent): void => {
      try {
        const data = JSON.parse(message.data);
        if (data[0] === 'OK' && data[1] === event.id) {
          finish(data[2] === true ? null : String(data[3] ?? 'refused'));
        }
      } catch {
        // A relay that sends something unparseable has not said yes.
      }
    };

    socket.onerror = (): void => finish('connection failed');
    socket.onclose = (): void => finish('closed before answering');
  });
}

/**
 * Signs and publishes. Resolves once every relay has answered or timed out.
 *
 * One relay accepting is enough for the note to exist, so the caller is given
 * both lists and decides what to say about it.
 */
export async function publishNote(content: string): Promise<PublishResult> {
  const key: Uint8Array | null = getSessionPrivateKey();
  if (!key) {
    throw new NotSignedInError();
  }

  const draft = withClientTag({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [] as string[][],
    content,
    pubkey: '',
  });

  const event = finalizeEvent(
    {
      kind: draft.kind,
      created_at: draft.created_at,
      tags: draft.tags,
      content: draft.content,
    },
    key,
  ) as unknown as NostrEvent;

  return publishSigned(event);
}

/**
 * Sends an already-signed event to every configured relay.
 *
 * Split out so reactions and follow lists deliver by the same route a note
 * does - one place that decides what "it worked" means, rather than three.
 */
export async function publishSigned(event: NostrEvent): Promise<PublishResult> {
  const relays: string[] = getRelays();
  const verdicts = await Promise.all(
    relays.map(
      async (relay: string): Promise<{ relay: string; reason: string | null }> => ({
        relay,
        reason: await publishTo(relay, event),
      }),
    ),
  );

  return {
    event,
    accepted: verdicts
      .filter((v): boolean => v.reason === null)
      .map((v): string => v.relay),
    rejected: verdicts
      .filter((v): boolean => v.reason !== null)
      .map((v): { relay: string; reason: string } => ({
        relay: v.relay,
        reason: v.reason as string,
      })),
  };
}

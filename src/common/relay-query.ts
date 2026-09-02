/**
 * One filter, every relay, the events deduplicated.
 *
 * The shape of most reads in the app: ask each relay the same question,
 * keep one copy of each answer, stop waiting when the fan-out says so - a
 * short grace once one relay has answered, and a per-relay give-up for the
 * ones that never do. Used by the native timelines and by the web's poll
 * for new posts, which is why it lives here rather than in either.
 */

import type { NostrEvent } from '../../types/nostr';
import { fanOut, type RelayReport } from './relay-fanout.js';
import { openRelaySubscription } from './relay-socket.js';

/** A relay silent for this long is given up on. */
const QUERY_TIMEOUT_MS: number = 9000;
/** How long the others get once one relay has answered. */
const STRAGGLER_GRACE_MS: number = 1500;

export async function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<NostrEvent[]> {
  const byId: Map<string, NostrEvent> = new Map();

  await fanOut(
    relays,
    (relayUrl: string, report: RelayReport): Promise<() => void> => {
      const timeout = setTimeout((): void => report.gaveUp(), QUERY_TIMEOUT_MS);
      return openRelaySubscription(relayUrl, filter, {
        onEvent: (event: NostrEvent): void => {
          if (!byId.has(event.id)) byId.set(event.id, event);
        },
        onEose: (): void => report.answered(),
        onClosed: (): void => report.gaveUp(),
      })
        .then((stop: () => void): (() => void) => (): void => {
          clearTimeout(timeout);
          stop();
        })
        .catch((error: unknown): never => {
          clearTimeout(timeout);
          throw error;
        });
    },
    { stragglerGraceMs: STRAGGLER_GRACE_MS },
  );

  return Array.from(byId.values());
}

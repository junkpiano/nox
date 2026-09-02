/**
 * One filter, every relay, the events deduplicated - and whether anyone
 * actually answered.
 *
 * The shape of most reads in the app: ask each relay the same question,
 * keep one copy of each answer, stop waiting when the fan-out says so - a
 * short grace once one relay has answered, and a per-relay give-up for the
 * ones that never do.
 *
 * An empty answer and no answer look the same in the list of events, and
 * they mean opposite things to a caller deciding whether a post was
 * withdrawn: "no relay has a deletion for it" clears the post, "no relay
 * could be reached" says nothing. So the detailed form reports how many
 * relays reached EOSE, and a caller that must not mistake silence for an
 * answer checks it.
 */

import type { NostrEvent } from '../../types/nostr';
import { fanOut, type RelayReport } from './relay-fanout.js';
import { openRelaySubscription } from './relay-socket.js';

/** A relay silent for this long is given up on. */
const QUERY_TIMEOUT_MS: number = 9000;
/** How long the others get once one relay has answered. */
const STRAGGLER_GRACE_MS: number = 1500;

export interface RelayQueryResult {
  events: NostrEvent[];
  /** How many relays sent EOSE - said everything they had, even if nothing. */
  answered: number;
}

/** What a subscription reports, in the shape the relay socket accepts. */
export interface RelaySubscriptionHandlers {
  onEvent?: ((event: NostrEvent) => void) | undefined;
  onEose?: (() => void) | undefined;
  onClosed?: ((reason: string) => void) | undefined;
}

/** Opens one subscription; the real one talks to a relay, a test's does not. */
export type SubscriptionOpener = (
  relayUrl: string,
  filter: Record<string, unknown>,
  handlers: RelaySubscriptionHandlers,
) => Promise<() => void>;

/** Thrown by a caller for whom silence from every relay is not an answer. */
export class NoRelayAnsweredError extends Error {
  constructor(relays: string[]) {
    super(`No relay answered (${relays.length} asked)`);
    this.name = 'NoRelayAnsweredError';
  }
}

export async function queryRelaysDetailed(
  relays: string[],
  filter: Record<string, unknown>,
  open: SubscriptionOpener = openRelaySubscription,
): Promise<RelayQueryResult> {
  const byId: Map<string, NostrEvent> = new Map();

  const outcome = await fanOut(
    relays,
    (relayUrl: string, report: RelayReport): Promise<() => void> => {
      const timeout = setTimeout((): void => report.gaveUp(), QUERY_TIMEOUT_MS);
      return open(relayUrl, filter, {
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

  return {
    events: Array.from(byId.values()),
    answered: outcome.answered.length,
  };
}

/** The events alone, for callers to whom an empty answer is just empty. */
export async function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
  open?: SubscriptionOpener,
): Promise<NostrEvent[]> {
  const result: RelayQueryResult = await queryRelaysDetailed(
    relays,
    filter,
    open,
  );
  return result.events;
}

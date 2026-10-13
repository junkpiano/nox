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
import { clearRelayTimeout, setRelayTimeout } from './relay-schedule.js';
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

export interface RelayQueryOptions {
  /** Wait for every relay to answer or give up, rather than a grace after the first. */
  everyRelay?: boolean;
}

export async function queryRelaysDetailed(
  relays: string[],
  filter: Record<string, unknown>,
  open: SubscriptionOpener = openRelaySubscription,
  options: RelayQueryOptions = {},
): Promise<RelayQueryResult> {
  const byId: Map<string, NostrEvent> = new Map();

  const outcome = await fanOut(
    relays,
    (relayUrl: string, report: RelayReport): Promise<() => void> => {
      // Ordered with the relay's traffic, so what arrived in time is kept.
      const timeout = setRelayTimeout(
        (): void => report.gaveUp(),
        QUERY_TIMEOUT_MS,
      );
      return open(relayUrl, filter, {
        onEvent: (event: NostrEvent): void => {
          if (!byId.has(event.id)) byId.set(event.id, event);
        },
        onEose: (): void => report.answered(),
        onClosed: (): void => report.gaveUp(),
      })
        .then((stop: () => void): (() => void) => (): void => {
          clearRelayTimeout(timeout);
          stop();
        })
        .catch((error: unknown): never => {
          clearRelayTimeout(timeout);
          throw error;
        });
    },
    options.everyRelay ? {} : { stragglerGraceMs: STRAGGLER_GRACE_MS },
  );

  return {
    events: Array.from(byId.values()),
    answered: outcome.answered.length,
  };
}

/**
 * Every relay's word. For a replaceable list - the mute list, a relay list -
 * whose newest copy may sit on the slowest relay: the first answer plus a
 * grace could return the stale copy, and the next edit would republish it.
 */
export async function queryEveryRelay(
  relays: string[],
  filter: Record<string, unknown>,
  open?: SubscriptionOpener,
): Promise<NostrEvent[]> {
  const result: RelayQueryResult = await queryRelaysDetailed(
    relays,
    filter,
    open,
    { everyRelay: true },
  );
  return result.events;
}

/** Whether `a` replaces `b`: later, or the same second and the lower id (NIP-01). */
export function supersedes(
  a: { created_at: number; id: string },
  b: { created_at: number; id: string },
): boolean {
  return (
    a.created_at > b.created_at ||
    (a.created_at === b.created_at && a.id < b.id)
  );
}

/** The latest of a replaceable kind, or null when no relay had one. */
export function newestOf(events: NostrEvent[]): NostrEvent | null {
  let newest: NostrEvent | null = null;
  for (const event of events) {
    if (!newest || supersedes(event, newest)) newest = event;
  }
  return newest;
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

/**
 * Several filters, as one REQ would OR them: each asked with `bounds`
 * (`since`, `until`, `limit`) added, the answers merged, each event once.
 *
 * A filter that filled its limit may have more just older than its oldest.
 * Anything older than that, from the other filters, is left for the next
 * page: a cursor taken from the merged oldest would otherwise step past
 * what the full filter never got to send.
 */
export async function queryRelaysAny(
  relays: string[],
  filters: Record<string, unknown> | Array<Record<string, unknown>>,
  bounds: Record<string, unknown> = {},
): Promise<NostrEvent[]> {
  const list = Array.isArray(filters) ? filters : [filters];
  const results: RelayQueryResult[] = await Promise.all(
    list.map(
      (filter: Record<string, unknown>): Promise<RelayQueryResult> =>
        queryRelaysDetailed(relays, { ...filter, ...bounds }),
    ),
  );
  // Some filters answered and another went unheard: the merged answer has a
  // hole a cursor would step over. Failing lets the caller ask again.
  if (
    results.some((result) => result.answered === 0) &&
    results.some((result) => result.answered > 0)
  ) {
    throw new NoRelayAnsweredError(relays);
  }
  const answers: NostrEvent[][] = results.map((result) => result.events);
  const limit: unknown = bounds.limit;
  let floor: number = Number.NEGATIVE_INFINITY;
  // Backward only: a poll's `since` is the floor, and what it drops would
  // fall below the next poll's.
  if (
    typeof limit === 'number' &&
    bounds.since === undefined &&
    answers.length > 1
  ) {
    for (const answer of answers) {
      if (answer.length < limit) continue;
      const oldest: number = Math.min(...answer.map((e) => e.created_at));
      floor = Math.max(floor, oldest);
    }
  }
  const byId: Map<string, NostrEvent> = new Map();
  for (const event of answers.flat()) {
    if (event.created_at >= floor && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return Array.from(byId.values());
}

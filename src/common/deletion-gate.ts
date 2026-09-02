/**
 * What has been withdrawn, remembered, and the gate a list goes through.
 *
 * NIP-09 is honoured by the client, and a client honours it by asking. The
 * web timelines did not: a card checked its quoted note for a kind 5 and
 * never itself, so a post its author had withdrawn came back the moment the
 * cache was cleared and the relays were asked again. The native timelines
 * asked in one batch before drawing anything. This is that batch, for both.
 *
 * `findDeletedIds` asks the relays once about a whole list and remembers
 * the answers. A withdrawal is remembered for good - nothing un-withdraws a
 * post. A clearance is remembered only for a while, because the author may
 * withdraw the post after it was checked, and a tab that never asked again
 * would keep showing it. `createDeletionGate` is the shape a streaming list
 * needs: events are offered as they arrive, held for a moment, checked
 * together, and drawn only if they survive.
 */

import type { NostrEvent } from '../../types/nostr';
import { fetchDeletedIds } from './deleted-events.js';

/** How long "not withdrawn" is believed before the relays are asked again. */
export const CLEARED_TTL_MS: number = 5 * 60 * 1000;

interface Remembered {
  deleted: boolean;
  /** When the answer came. */
  at: number;
}

const known: Map<string, Remembered> = new Map();

/**
 * What was remembered about an event: `true` withdrawn, `false` cleared
 * recently enough to still believe, `undefined` never asked or worth
 * asking again.
 */
export function getCachedDeletionStatus(
  eventId: string,
  now: number = Date.now(),
): boolean | undefined {
  const remembered: Remembered | undefined = known.get(eventId);
  if (!remembered) return undefined;
  if (remembered.deleted) return true;
  if (now - remembered.at > CLEARED_TTL_MS) {
    known.delete(eventId);
    return undefined;
  }
  return false;
}

export function cacheDeletionStatus(
  eventId: string,
  deleted: boolean,
  at: number = Date.now(),
): void {
  known.set(eventId, { deleted, at });
}

export type DeletedIdsFetcher = (
  relays: string[],
  events: NostrEvent[],
) => Promise<Set<string>>;

/**
 * Which of these the author has withdrawn.
 *
 * Only the ones nobody has asked about lately go to the relays; the rest
 * are answered from memory. When no relay could be reached the fetch
 * throws, nothing is remembered for the events it was asked about, and
 * they are asked about again next time rather than shown as if cleared.
 */
export async function findDeletedIds(
  relays: string[],
  events: NostrEvent[],
  fetch: DeletedIdsFetcher = fetchDeletedIds,
  now: number = Date.now(),
): Promise<Set<string>> {
  const deleted: Set<string> = new Set();
  const unknown: NostrEvent[] = [];
  for (const event of events) {
    const status: boolean | undefined = getCachedDeletionStatus(event.id, now);
    if (status === true) deleted.add(event.id);
    else if (status === undefined) unknown.push(event);
  }
  if (unknown.length === 0) return deleted;

  let found: Set<string>;
  try {
    found = await fetch(relays, unknown);
  } catch {
    return deleted;
  }
  for (const event of unknown) {
    const gone: boolean = found.has(event.id);
    cacheDeletionStatus(event.id, gone, now);
    if (gone) deleted.add(event.id);
  }
  return deleted;
}

export interface DeletionGate<T extends NostrEvent> {
  /** Hands an event to the gate. It is drawn after the next check, if at all. */
  offer(event: T): void;
  /** Checks and draws whatever is waiting now, without waiting for the timer. */
  flush(): Promise<void>;
  /** Resolves once every check that has started has finished drawing. */
  settle(): Promise<void>;
}

export function createDeletionGate<T extends NostrEvent>(options: {
  relays: string[];
  /** How long arrivals are held so they can be checked together. */
  delayMs: number;
  /** Draws the survivors, in the order they were offered. */
  render: (events: T[]) => void;
  /** Told about the ones that did not survive, for whoever caches them. */
  onDeleted?: ((ids: string[]) => void) | undefined;
  fetch?: DeletedIdsFetcher | undefined;
}): DeletionGate<T> {
  let waiting: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inFlight: Set<Promise<void>> = new Set();

  const check = async (batch: T[]): Promise<void> => {
    const deleted: Set<string> = await findDeletedIds(
      options.relays,
      batch,
      options.fetch,
    );
    const survivors: T[] = batch.filter(
      (event: T): boolean => !deleted.has(event.id),
    );
    if (deleted.size > 0) options.onDeleted?.(Array.from(deleted));
    if (survivors.length > 0) options.render(survivors);
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (waiting.length === 0) return Promise.resolve();
    const batch: T[] = waiting;
    waiting = [];
    const run: Promise<void> = check(batch).finally((): void => {
      inFlight.delete(run);
    });
    inFlight.add(run);
    return run;
  };

  return {
    offer(event: T): void {
      waiting.push(event);
      if (timer === null) {
        timer = setTimeout((): void => {
          timer = null;
          void flush();
        }, options.delayMs);
      }
    },
    flush,
    async settle(): Promise<void> {
      await flush();
      await Promise.all(Array.from(inFlight));
    },
  };
}

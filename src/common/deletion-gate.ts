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
 * every answer, so nothing is asked about twice. `createDeletionGate` is
 * the shape a streaming list needs: events are offered as they arrive, held
 * for a moment, checked together, and drawn only if they survive.
 */

import type { NostrEvent } from '../../types/nostr';
import { fetchDeletedIds } from './deleted-events.js';

const known: Map<string, boolean> = new Map();

export function getCachedDeletionStatus(eventId: string): boolean | undefined {
  return known.get(eventId);
}

export function cacheDeletionStatus(eventId: string, deleted: boolean): void {
  known.set(eventId, deleted);
}

export type DeletedIdsFetcher = (
  relays: string[],
  events: NostrEvent[],
) => Promise<Set<string>>;

/**
 * Which of these the author has withdrawn.
 *
 * Only the ones nobody has asked about yet go to the relays; the rest are
 * answered from memory. A relay that cannot be reached answers nothing, and
 * nothing is remembered for the events it was asked about, so they are
 * asked about again next time rather than shown as if cleared.
 */
export async function findDeletedIds(
  relays: string[],
  events: NostrEvent[],
  fetch: DeletedIdsFetcher = fetchDeletedIds,
): Promise<Set<string>> {
  const deleted: Set<string> = new Set();
  const unknown: NostrEvent[] = [];
  for (const event of events) {
    const status: boolean | undefined = known.get(event.id);
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
    known.set(event.id, gone);
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

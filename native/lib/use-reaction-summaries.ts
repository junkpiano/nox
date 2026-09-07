/**
 * Who reacted to the posts on this screen.
 *
 * One book for the whole app, so a post seen on the home timeline is not
 * asked about again when it opens as a thread. The posts of a render are
 * asked about together - a `#e` filter takes a list - and an answer is
 * believed for a few minutes: a count that is a minute stale is not a
 * problem, and a subscription per card would be.
 */

import { useEffect, useState } from 'react';
import type { ReactionAggregate } from '../../src/common/reaction-interactions';
import { fetchReactionSummaries } from '../../src/common/reaction-summary';
import { getRelays } from '../../src/features/relays/relays';

/** How long a count is believed before that post is asked about again. */
const TTL_MS: number = 5 * 60 * 1000;

/**
 * A count the app itself moved is worth less trust than one the relays
 * gave: it knows an action happened, not who else had already been counted.
 * So it is asked about again soon rather than believed for the full term.
 */
const OPTIMISTIC_TTL_MS: number = 20 * 1000;

/**
 * How many posts the book remembers. A timeline scrolled all evening would
 * otherwise grow it without end; the ones asked about longest ago go first,
 * and a post dropped from the book is simply asked about again.
 */
const MAX_REMEMBERED: number = 600;

const known: Map<string, ReactionAggregate[]> = new Map();
const askedAt: Map<string, number> = new Map();
const pending: Map<string, Promise<void>> = new Map();
const listeners: Set<() => void> = new Set();

/**
 * Every count the app moves itself is numbered, per post. A lookup that
 * was already out when one happened leaves that post alone: the relays
 * were asked before the like existed, so their answer is older than it.
 */
let edits: number = 0;
const editedAt: Map<string, number> = new Map();

function announce(): void {
  for (const listener of Array.from(listeners)) listener();
}

function evictIfCrowded(): void {
  // Counted over what is held, not over what was asked: a failed lookup
  // clears its asked time and would otherwise leave the post it was about
  // invisible to this bound for good.
  if (known.size <= MAX_REMEMBERED) return;
  const oldestFirst: string[] = Array.from(known.keys()).sort(
    (a: string, b: string): number =>
      (askedAt.get(a) ?? 0) - (askedAt.get(b) ?? 0),
  );
  for (const id of oldestFirst.slice(0, known.size - MAX_REMEMBERED)) {
    if (pending.has(id)) continue;
    askedAt.delete(id);
    known.delete(id);
    editedAt.delete(id);
  }
}

async function ask(ids: string[]): Promise<void> {
  const now: number = Date.now();
  const fresh: string[] = ids.filter((id: string): boolean => {
    if (pending.has(id)) return false;
    const at: number | undefined = askedAt.get(id);
    return at === undefined || now - at >= TTL_MS;
  });
  if (fresh.length === 0) return;

  for (const id of fresh) askedAt.set(id, now);
  const startedAt: number = edits;
  const flight: Promise<void> = fetchReactionSummaries(fresh, getRelays())
    .then((found: Map<string, ReactionAggregate[]>): void => {
      // An answer replaces what was held, including with nothing: a
      // reaction withdrawn elsewhere is not a reaction now. A post the app
      // itself counted while the question was out keeps the app's answer.
      for (const id of fresh) {
        if ((editedAt.get(id) ?? 0) > startedAt) continue;
        known.set(id, found.get(id) ?? []);
      }
      announce();
    })
    .catch((): void => {
      // Nobody answered. That is not knowledge about any of these, so they
      // are asked again rather than shown as having none.
      for (const id of fresh) askedAt.delete(id);
    })
    .finally((): void => {
      for (const id of fresh) pending.delete(id);
      evictIfCrowded();
    });
  for (const id of fresh) pending.set(id, flight);
  await flight;
}

/** Screens currently drawing counts, so a reconciliation reaches them. */
const mounted: Set<() => string[]> = new Set();

/**
 * Posts whose count the app moved itself and which are waiting to be
 * settled by the relays. Checked on a timer, since nothing else would
 * ask again while the same posts stay on screen.
 */
const unsettled: Set<string> = new Set();
let reconciler: ReturnType<typeof setTimeout> | null = null;

function scheduleReconcile(): void {
  if (reconciler !== null) return;
  reconciler = setTimeout((): void => {
    reconciler = null;
    const showing: Set<string> = new Set();
    for (const ids of mounted) for (const id of ids()) showing.add(id);
    const settle: string[] = Array.from(unsettled).filter((id: string) =>
      showing.has(id),
    );
    unsettled.clear();
    if (settle.length > 0) {
      // The asked time was backdated when the count moved, so this asks.
      void ask(settle);
    }
  }, OPTIMISTIC_TTL_MS);
}

/**
 * Records a reaction the app just made, so the count moves at once rather
 * than after the next ask.
 *
 * This counts an action, not a person: the book does not know whether the
 * relays had already counted this viewer. So the post is asked about again
 * once the reconciler fires, and the relays' answer settles it.
 */
export function countOwnReaction(eventId: string, content: string): void {
  const entries: ReactionAggregate[] = known.get(eventId) ?? [];
  const key: string = `text:${content}`;
  const existing: ReactionAggregate | undefined = entries.find(
    (entry: ReactionAggregate): boolean => entry.key === key,
  );
  const next: ReactionAggregate[] = existing
    ? entries.map(
        (entry: ReactionAggregate): ReactionAggregate =>
          entry.key === key ? { ...entry, count: entry.count + 1 } : entry,
      )
    : [...entries, { count: 1, key, content }];
  known.set(
    eventId,
    next.sort(
      (a: ReactionAggregate, b: ReactionAggregate): number => b.count - a.count,
    ),
  );
  editedAt.set(eventId, ++edits);
  askedAt.set(eventId, Date.now() - TTL_MS);
  unsettled.add(eventId);
  scheduleReconcile();
  announce();
}

export function useReactionSummaries(
  ids: ReadonlyArray<string>,
): ReadonlyMap<string, ReactionAggregate[]> {
  const [, bump] = useState(0);
  const wanted: string = Array.from(new Set(ids)).sort().join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: the ids are the dependency, not the array
  useEffect((): (() => void) => {
    const listener = (): void => bump((n: number): number => n + 1);
    listeners.add(listener);
    // What this screen is showing, so a reconciliation knows where to look.
    const showing = (): string[] => (wanted ? wanted.split(',') : []);
    mounted.add(showing);
    if (wanted) void ask(showing());
    return (): void => {
      listeners.delete(listener);
      mounted.delete(showing);
    };
  }, [wanted]);

  return known;
}

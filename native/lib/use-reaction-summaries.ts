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

const known: Map<string, ReactionAggregate[]> = new Map();
const askedAt: Map<string, number> = new Map();
const pending: Map<string, Promise<void>> = new Map();
const listeners: Set<() => void> = new Set();

function announce(): void {
  for (const listener of Array.from(listeners)) listener();
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
  const flight: Promise<void> = fetchReactionSummaries(fresh, getRelays())
    .then((found: Map<string, ReactionAggregate[]>): void => {
      // An answer replaces what was held, including with nothing: a
      // reaction withdrawn elsewhere is not a reaction now.
      for (const id of fresh) known.set(id, found.get(id) ?? []);
      announce();
    })
    .catch((): void => {
      // Nobody answered. That is not knowledge about any of these, so they
      // are asked again rather than shown as having none.
      for (const id of fresh) askedAt.delete(id);
    })
    .finally((): void => {
      for (const id of fresh) pending.delete(id);
    });
  for (const id of fresh) pending.set(id, flight);
  await flight;
}

/**
 * Records a reaction the app just made, so the count moves at once rather
 * than after the next ask.
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
    if (wanted) void ask(wanted.split(','));
    return (): void => {
      listeners.delete(listener);
    };
  }, [wanted]);

  return known;
}

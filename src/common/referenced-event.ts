/**
 * Fetching an event somebody else pointed at - a quote, a reply's parent, a
 * repost with no embedded copy.
 *
 * Cache-first, in three layers, because the same event is pointed at from
 * many places and each place used to ask the relays again:
 *
 *   1. an in-flight map, so two cards quoting the same note share one request
 *      rather than racing two;
 *   2. the main event cache (`nostr_cache_v2`), which is the source of truth
 *      for anything this app has already seen;
 *   3. the relays - the recipient's hints first, then the configured list.
 *
 * A miss is remembered for a minute. A note that is not on any relay we know
 * stays not there for a while, and a timeline with twenty quotes of it should
 * not ask twenty times.
 *
 * This lived inside the web card renderer. The phone needed the same thing
 * and was about to get a second, cacheless copy.
 */

import type { NostrEvent } from '../../types/nostr';
import { getCachedEvent, setCachedEvent } from './event-cache.js';
import { fetchEventById } from './events-queries.js';

const IN_FLIGHT_LIMIT: number = 1000;
const MISS_LIMIT: number = 2000;
const MISS_TTL_MS: number = 60 * 1000;

const inFlight: Map<string, Promise<NostrEvent | null>> = new Map();
const misses: Map<string, number> = new Map();

function rememberInFlight(
  eventId: string,
  request: Promise<NostrEvent | null>,
): void {
  inFlight.delete(eventId);
  inFlight.set(eventId, request);
  if (inFlight.size > IN_FLIGHT_LIMIT) {
    const oldest: string | undefined = inFlight.keys().next().value;
    if (oldest) {
      inFlight.delete(oldest);
    }
  }
}

/**
 * Marks an event as not found, for a caller that has already retried on its
 * own and wants the next asker to stop for a minute.
 */
export function rememberReferencedMiss(eventId: string): void {
  rememberMiss(eventId);
}

function rememberMiss(eventId: string): void {
  misses.delete(eventId);
  misses.set(eventId, Date.now() + MISS_TTL_MS);
  if (misses.size > MISS_LIMIT) {
    const oldest: string | undefined = misses.keys().next().value;
    if (oldest) {
      misses.delete(oldest);
    }
  }
}

function isRecentMiss(eventId: string): boolean {
  const expiresAt: number | undefined = misses.get(eventId);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    misses.delete(eventId);
    return false;
  }
  return true;
}

export interface ReferencedEventOptions {
  /**
   * Relays the reference itself named - an `nevent` carries them. Asked
   * first, and in addition to the configured list: a hint is where the
   * author says the event is, and an event that only lives there is exactly
   * the case hints exist for.
   */
  hintRelays?: string[];
  /** Ask again even if a miss was remembered. */
  bypassNullCache?: boolean;
  /** Drop any in-flight request and start over. */
  forceRefresh?: boolean;
}

/** Deduplicated, with hints first. */
function relaysToAsk(configured: string[], hints: string[]): string[] {
  const seen: Set<string> = new Set();
  const ordered: string[] = [];
  for (const relay of [...hints, ...configured]) {
    if (relay && !seen.has(relay)) {
      seen.add(relay);
      ordered.push(relay);
    }
  }
  return ordered;
}

export async function fetchReferencedEvent(
  eventId: string,
  relays: string[],
  options: ReferencedEventOptions = {},
): Promise<NostrEvent | null> {
  const bypassNullCache: boolean = options.bypassNullCache === true;

  if (!bypassNullCache && isRecentMiss(eventId)) {
    return null;
  }

  if (options.forceRefresh) {
    inFlight.delete(eventId);
  } else {
    const pending: Promise<NostrEvent | null> | undefined =
      inFlight.get(eventId);
    if (pending) {
      rememberInFlight(eventId, pending);
      return pending;
    }
  }

  const request: Promise<NostrEvent | null> =
    (async (): Promise<NostrEvent | null> => {
      const cached: NostrEvent | null = await getCachedEvent(eventId);
      if (cached) {
        misses.delete(eventId);
        return cached;
      }

      const event: NostrEvent | null = await fetchEventById(
        eventId,
        relaysToAsk(relays, options.hintRelays ?? []),
      );
      if (event) {
        misses.delete(eventId);
        await setCachedEvent(event);
        return event;
      }

      inFlight.delete(eventId);
      if (!bypassNullCache) {
        rememberMiss(eventId);
      }
      return null;
    })();

  rememberInFlight(eventId, request);
  return request;
}

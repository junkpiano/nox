import { verifyEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { recordRelayFailure } from '../features/relays/relays.js';
import { promiseAny, RelayMissError } from './promise-utils.js';
import { fanOut, type RelayReport } from './relay-fanout.js';
import { openRelaySubscription } from './relay-socket.js';

const FOLLOW_LIST_MAX_FUTURE_SKEW_SECONDS: number = 5 * 60;
/** A relay silent for this long is recorded as failing and given up on. */
const FOLLOW_LIST_RELAY_TIMEOUT_MS: number = 5000;
/** How long the other relays get once one has answered. */
const FOLLOW_LIST_STRAGGLER_GRACE_MS: number = 1500;

// The memory of what was withdrawn lives with the gate that consults it.
export {
  cacheDeletionStatus,
  getCachedDeletionStatus,
} from './deletion-gate.js';

export interface FollowListFetchOptions {
  /**
   * Wait for every relay to answer or time out, rather than returning
   * shortly after the first answer. For a lookup whose result is about to
   * be republished: the newest list may be on the slow relay, and
   * publishing an older one in its place drops every follow made since.
   */
  waitForAll?: boolean;
}

/**
 * What a follow-list lookup actually learned.
 *
 * `event: null` on its own is ambiguous in a way that matters: it means both
 * "this person has no contact list yet" and "no relay would tell us". The
 * first is a new account whose first follow should be allowed; the second is
 * a state in which publishing a kind 3 would replace a real list with an
 * empty one. `answered` separates them.
 */
export interface FollowListLookup {
  event: NostrEvent | null;
  /** At least one relay reached EOSE, so an absent event means it is absent. */
  answered: boolean;
}

/**
 * Fetches the newest kind 3, and reports whether anyone answered.
 *
 * The relay-by-relay outcome was already being collected here for logging;
 * this returns it, because the caller deciding whether to publish is the one
 * who needs it.
 */
export async function lookupFollowList(
  pubkeyHex: PubkeyHex,
  relays: string[],
  options: FollowListFetchOptions = {},
): Promise<FollowListLookup> {
  console.log(`Fetching follow list for ${pubkeyHex}`);
  let latestFollowTimestamp: number = -1;
  let latestFollowTagCount: number = 0;
  let latestFollowEvent: NostrEvent | null = null;

  const relayResults: Map<
    string,
    { gotEvent: boolean; tagCount: number; createdAt: number | null }
  > = new Map();

  // Readers return once one relay has answered and the rest have had a
  // moment; a dead relay no longer costs its full timeout on every load.
  // A caller about to republish waits for everyone, since the list it
  // publishes replaces whatever the slow relay had.
  await fanOut(
    relays,
    (relayUrl: string, report: RelayReport): Promise<() => void> => {
      const timeout = setTimeout((): void => {
        recordRelayFailure(relayUrl);
        report.gaveUp();
      }, FOLLOW_LIST_RELAY_TIMEOUT_MS);

      console.log(`Requesting follows from ${relayUrl}`);
      return openRelaySubscription(
        relayUrl,
        { kinds: [3], authors: [pubkeyHex], limit: 50 },
        {
          onEvent: (event: NostrEvent): void => {
            if (event.kind !== 3 || event.pubkey !== pubkeyHex) {
              return;
            }

            if (!verifyEvent(event)) {
              console.warn(
                `Ignoring invalid follow-list signature from ${relayUrl}`,
              );
              return;
            }

            const nowSeconds: number = Math.floor(Date.now() / 1000);
            if (
              event.created_at >
              nowSeconds + FOLLOW_LIST_MAX_FUTURE_SKEW_SECONDS
            ) {
              console.warn(
                `Ignoring future-skewed follow list from ${relayUrl}: ${event.created_at}`,
              );
              return;
            }

            const prevTagCount: number = latestFollowEvent
              ? latestFollowEvent.tags.length
              : 0;
            const isNewer: boolean = event.created_at > latestFollowTimestamp;
            const isSameSecondButRicher: boolean =
              event.created_at === latestFollowTimestamp &&
              event.tags.length > prevTagCount;
            if (isNewer || isSameSecondButRicher) {
              latestFollowTimestamp = event.created_at;
              latestFollowTagCount = event.tags.length;
              latestFollowEvent = event;
            }
            relayResults.set(relayUrl, {
              gotEvent: true,
              tagCount: event.tags.length,
              createdAt: event.created_at,
            });
            console.log(
              `Got kind 3 event from ${relayUrl} with ${event.tags.length} tags at ${event.created_at}`,
            );
          },
          onEose: (): void => {
            if (!relayResults.has(relayUrl)) {
              relayResults.set(relayUrl, {
                gotEvent: false,
                tagCount: 0,
                createdAt: null,
              });
            }
            report.answered();
          },
          onClosed: (): void => {
            report.gaveUp();
          },
        },
      )
        .then((unsubscribe: () => void): (() => void) => (): void => {
          clearTimeout(timeout);
          unsubscribe();
        })
        .catch((error: unknown): never => {
          console.error(`WebSocket error [${relayUrl}]`, error);
          clearTimeout(timeout);
          throw error;
        });
    },
    options.waitForAll
      ? {}
      : { stragglerGraceMs: FOLLOW_LIST_STRAGGLER_GRACE_MS },
  );

  console.log(`Follow list relay summary:`, Array.from(relayResults.entries()));
  console.log(
    `Using latest kind 3 event at ${latestFollowTimestamp >= 0 ? latestFollowTimestamp : 'n/a'}, tags: ${latestFollowTimestamp >= 0 ? latestFollowTagCount : 'none'}`,
  );

  return {
    event: latestFollowEvent,
    // An entry exists for a relay only once it has reached EOSE or delivered
    // an event; one is enough to know the absence is real.
    answered: relayResults.size > 0 || latestFollowEvent !== null,
  };
}

/**
 * The newest kind 3, or null.
 *
 * Kept for callers that only want to read the list. Anything about to
 * *publish* one wants {@link lookupFollowList} instead, because null here
 * cannot tell an empty list from an unreachable one.
 */
export async function fetchLatestFollowListEvent(
  pubkeyHex: PubkeyHex,
  relays: string[],
  options: FollowListFetchOptions = {},
): Promise<NostrEvent | null> {
  const lookup: FollowListLookup = await lookupFollowList(
    pubkeyHex,
    relays,
    options,
  );
  return lookup.event;
}

/**
 * Convenience wrapper returning just the followed pubkeys from the latest kind-3.
 * Returns `[]` when no follow list was found — do NOT use this for republishing;
 * use {@link fetchLatestFollowListEvent} so an empty/failed fetch can be distinguished.
 */
export async function fetchFollowList(
  pubkeyHex: PubkeyHex,
  relays: string[],
): Promise<PubkeyHex[]> {
  const event: NostrEvent | null = await fetchLatestFollowListEvent(
    pubkeyHex,
    relays,
  );
  if (!event) {
    return [];
  }

  const followedPubkeys: Set<PubkeyHex> = new Set();
  event.tags.forEach((tag: string[]): void => {
    if (tag[0] === 'p' && tag[1]) {
      followedPubkeys.add(tag[1] as PubkeyHex);
    }
  });
  return Array.from(followedPubkeys);
}

async function fetchEventFromRelay(
  eventId: string,
  relayUrl: string,
  timeoutMs: number,
): Promise<NostrEvent | null> {
  return await new Promise<NostrEvent | null>((resolve) => {
    let settled: boolean = false;
    let unsubscribe: (() => void) | null = null;

    const finish = (event: NostrEvent | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(event);
    };

    const timeout = setTimeout((): void => {
      recordRelayFailure(relayUrl);
      finish(null);
    }, timeoutMs);

    void openRelaySubscription(
      relayUrl,
      { ids: [eventId], limit: 1 },
      {
        onEvent: (event: NostrEvent): void => {
          finish(event);
        },
        onEose: (): void => {
          finish(null);
        },
        onClosed: (): void => {
          finish(null);
        },
      },
    )
      .then((nextUnsubscribe: () => void): void => {
        unsubscribe = nextUnsubscribe;
      })
      .catch((): void => {
        finish(null);
      });
  });
}

export async function fetchEventById(
  eventId: string,
  relays: string[],
): Promise<NostrEvent | null> {
  if (relays.length === 0) {
    return null;
  }

  const requests: Promise<NostrEvent>[] = relays.map(
    async (relayUrl: string): Promise<NostrEvent> => {
      try {
        const event: NostrEvent | null = await fetchEventFromRelay(
          eventId,
          relayUrl,
          5000,
        );
        if (!event) {
          throw new RelayMissError();
        }
        return event;
      } catch (e) {
        if (!(e instanceof RelayMissError)) {
          console.warn(`Failed to fetch event ${eventId} from ${relayUrl}:`, e);
        }
        throw e;
      }
    },
  );

  try {
    return await promiseAny(requests);
  } catch {
    // All relays missed or failed (AggregateError-like case for Promise.any).
    return null;
  }
}

export async function isEventDeleted(
  eventId: string,
  authorPubkey: PubkeyHex,
  relays: string[],
): Promise<boolean> {
  if (relays.length === 0) {
    return false;
  }

  const perRelayTimeoutMs: number = 3000;
  const overallTimeoutMs: number = 3000;

  const checks: Promise<boolean>[] = relays.map(
    async (relayUrl: string): Promise<boolean> => {
      try {
        return await new Promise<boolean>((resolve) => {
          let settled: boolean = false;
          let unsubscribe: (() => void) | null = null;

          const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe?.();
            resolve(value);
          };

          const timeout = setTimeout((): void => {
            recordRelayFailure(relayUrl);
            finish(false);
          }, perRelayTimeoutMs);

          void openRelaySubscription(
            relayUrl,
            {
              kinds: [5],
              authors: [authorPubkey],
              '#e': [eventId],
              limit: 20,
            },
            {
              onEvent: (deleteEvent: NostrEvent): void => {
                if (deleteEvent.kind !== 5) {
                  return;
                }
                const referencesTarget: boolean = deleteEvent.tags.some(
                  (tag: string[]): boolean =>
                    tag[0] === 'e' && tag[1] === eventId,
                );
                if (referencesTarget) {
                  finish(true);
                }
              },
              onEose: (): void => {
                finish(false);
              },
              onClosed: (): void => {
                finish(false);
              },
            },
          )
            .then((nextUnsubscribe: () => void): void => {
              unsubscribe = nextUnsubscribe;
            })
            .catch((): void => {
              finish(false);
            });
        });
      } catch (e) {
        console.warn(`Failed to check delete event on ${relayUrl}:`, e);
        return false;
      }
    },
  );

  return await new Promise<boolean>((resolve) => {
    let settled: boolean = false;
    let pending: number = checks.length;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      resolve(value);
    };

    const overallTimeout = setTimeout((): void => {
      finish(false);
    }, overallTimeoutMs);

    if (pending === 0) {
      finish(false);
      return;
    }

    checks.forEach((check: Promise<boolean>): void => {
      check
        .then((deleted: boolean): void => {
          if (deleted) {
            finish(true);
            return;
          }
          pending -= 1;
          if (pending <= 0) {
            finish(false);
          }
        })
        .catch((): void => {
          pending -= 1;
          if (pending <= 0) {
            finish(false);
          }
        });
    });
  });
}

export async function fetchRepliesForEvent(
  eventId: string,
  relays: string[],
): Promise<NostrEvent[]> {
  if (relays.length === 0) {
    return [];
  }

  const results: Map<string, NostrEvent> = new Map();

  const promises = relays.map(async (relayUrl: string): Promise<void> => {
    try {
      await new Promise<void>((resolve) => {
        let settled: boolean = false;
        let unsubscribe: (() => void) | null = null;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe?.();
          resolve();
        };

        const timeout = setTimeout(() => {
          recordRelayFailure(relayUrl);
          finish();
        }, 5000);

        void openRelaySubscription(
          relayUrl,
          { kinds: [1], '#e': [eventId], limit: 200 },
          {
            onEvent: (event: NostrEvent): void => {
              results.set(event.id, event);
            },
            onEose: (): void => {
              finish();
            },
            onClosed: (): void => {
              finish();
            },
          },
        )
          .then((nextUnsubscribe: () => void): void => {
            unsubscribe = nextUnsubscribe;
          })
          .catch((): void => {
            finish();
          });
      });
    } catch (e) {
      console.warn(`Failed to fetch replies from ${relayUrl}:`, e);
    }
  });

  await Promise.allSettled(promises);

  const events: NostrEvent[] = Array.from(results.values());
  events.sort(
    (a: NostrEvent, b: NostrEvent): number => a.created_at - b.created_at,
  );
  return events;
}

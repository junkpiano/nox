/**
 * People's profiles (kind 0), for every front end.
 *
 * A memory cache in front of the profile store in front of the relays, with
 * in-flight lookups shared, a retry throttle per person, and several people
 * asked about in one query. The web and the phone both name people through
 * here, so a name learned on one screen is known on the next.
 */
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { recordRelayFailure } from '../features/relays/relays.js';
import {
  getProfile,
  getProfiles,
  profileNeedsRefresh,
  storeProfile,
} from './db/index.js';
import {
  promiseAny,
  RelayMissError as RelayProfileMissError,
} from './promise-utils.js';
import { newestOf, queryRelays } from './relay-query.js';
import { clearRelayTimeout, setRelayTimeout } from './relay-schedule.js';
import { openRelaySubscription } from './relay-socket.js';

const PROFILE_MEM_CACHE_TTL_MS: number = 5 * 60 * 1000;
const PROFILE_RETRY_INTERVAL_MS: number = 30 * 1000;
const profileMemoryCache: Map<
  PubkeyHex,
  { profile: NostrProfile | null; expiresAt: number }
> = new Map();
const profileInFlight: Map<PubkeyHex, Promise<NostrProfile | null>> = new Map();
const profileLastAttempt: Map<PubkeyHex, number> = new Map();

interface FetchProfileOptions {
  usePersistentCache?: boolean;
  forceRefresh?: boolean;
}

export async function cacheResolvedProfile(
  pubkeyHex: PubkeyHex,
  profile: NostrProfile,
): Promise<void> {
  await storeProfile(pubkeyHex, profile);
  profileMemoryCache.set(pubkeyHex, {
    profile,
    expiresAt: Date.now() + PROFILE_MEM_CACHE_TTL_MS,
  });
}

export function getAuthoritativeProfile(
  pubkeyHex: PubkeyHex,
  remoteProfile: NostrProfile | null,
): NostrProfile | null {
  const cachedMem:
    | { profile: NostrProfile | null; expiresAt: number }
    | undefined = profileMemoryCache.get(pubkeyHex);
  if (cachedMem?.profile) {
    return cachedMem.profile;
  }

  return remoteProfile;
}

export async function fetchProfile(
  pubkeyHex: PubkeyHex,
  relays: string[],
  options: FetchProfileOptions = {},
): Promise<NostrProfile | null> {
  const usePersistentCache: boolean = options.usePersistentCache !== false;
  const forceRefresh: boolean = options.forceRefresh === true;
  const now: number = Date.now();

  if (!forceRefresh) {
    const cachedMem:
      | { profile: NostrProfile | null; expiresAt: number }
      | undefined = profileMemoryCache.get(pubkeyHex);
    if (cachedMem && cachedMem.expiresAt > now) {
      return cachedMem.profile;
    }

    if (usePersistentCache) {
      const cachedProfile: NostrProfile | null = await getProfile(pubkeyHex);
      if (cachedProfile) {
        profileMemoryCache.set(pubkeyHex, {
          profile: cachedProfile,
          expiresAt: now + PROFILE_MEM_CACHE_TTL_MS,
        });
        return cachedProfile;
      }
    }
  }

  if (relays.length === 0) {
    return null;
  }

  const existing: Promise<NostrProfile | null> | undefined =
    profileInFlight.get(pubkeyHex);
  if (existing) {
    return await existing;
  }

  const lastAttempt: number | undefined = profileLastAttempt.get(pubkeyHex);
  if (
    !forceRefresh &&
    lastAttempt &&
    now - lastAttempt < PROFILE_RETRY_INTERVAL_MS
  ) {
    return null;
  }
  profileLastAttempt.set(pubkeyHex, now);

  const request: Promise<NostrProfile | null> =
    (async (): Promise<NostrProfile | null> => {
      const profileRequests: Promise<NostrProfile>[] = relays.map(
        async (relayUrl: string): Promise<NostrProfile> => {
          try {
            const profile: NostrProfile | null =
              await new Promise<NostrProfile | null>((resolve) => {
                let settled: boolean = false;
                let unsubscribe: (() => void) | null = null;

                const finish = (value: NostrProfile | null): void => {
                  if (settled) return;
                  settled = true;
                  clearRelayTimeout(timeout);
                  unsubscribe?.();
                  resolve(value);
                };

                const timeout = setRelayTimeout((): void => {
                  recordRelayFailure(relayUrl);
                  finish(null);
                }, 5000);

                void openRelaySubscription(
                  relayUrl,
                  { kinds: [0], authors: [pubkeyHex], limit: 1 },
                  {
                    onEvent: (eventPayload: NostrEvent): void => {
                      if (eventPayload.kind !== 0) {
                        return;
                      }

                      try {
                        if (typeof eventPayload.content !== 'string') {
                          finish(null);
                          return;
                        }

                        const parsed: NostrProfile = JSON.parse(
                          eventPayload.content,
                        );
                        const emojiTags: string[][] = Array.isArray(
                          eventPayload.tags,
                        )
                          ? eventPayload.tags.filter(
                              (tag: unknown): tag is string[] =>
                                Array.isArray(tag) && tag[0] === 'emoji',
                            )
                          : [];
                        parsed.emojiTags = emojiTags;
                        finish(parsed);
                      } catch (e) {
                        console.warn('Failed to parse profile JSON', e);
                      }
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
                  .catch((err: unknown): void => {
                    console.error(`WebSocket error [${relayUrl}]`, err);
                    finish(null);
                  });
              });

            if (!profile) {
              throw new RelayProfileMissError();
            }
            return profile;
          } catch (e) {
            if (!(e instanceof RelayProfileMissError)) {
              console.warn(`Failed to fetch profile from ${relayUrl}`, e);
            }
            throw e;
          }
        },
      );

      try {
        const profile: NostrProfile = await promiseAny(profileRequests);
        await cacheResolvedProfile(pubkeyHex, profile);
        return profile;
      } catch {
        // All relays missed or failed. Do NOT cache null in profileMemoryCache —
        // profileLastAttempt (30s throttle) prevents relay hammering, while
        // avoiding a 5-minute stale null that would block parent/repost card fetches.
      }
      return null;
    })();

  profileInFlight.set(pubkeyHex, request);
  try {
    return await request;
  } finally {
    profileInFlight.delete(pubkeyHex);
  }
}

/**
 * Several people's profiles with one question to the relays.
 *
 * The same caches as `fetchProfile` - memory, then the profile store - and
 * the same thirty-second throttle per person; whoever is left is asked about
 * together, a hundred to a query, instead of one subscription each. A post
 * naming twenty people otherwise sent twenty queries to every relay.
 */
export async function fetchProfiles(
  pubkeys: PubkeyHex[],
  relays: string[],
  options: { cachedOnly?: boolean } = {},
): Promise<Map<PubkeyHex, NostrProfile>> {
  const found: Map<PubkeyHex, NostrProfile> = new Map();
  const now: number = Date.now();
  let wanted: PubkeyHex[] = [];
  for (const pubkey of new Set(pubkeys)) {
    const cached = profileMemoryCache.get(pubkey);
    if (cached && cached.expiresAt > now) {
      if (cached.profile) found.set(pubkey, cached.profile);
    } else {
      wanted.push(pubkey);
    }
  }
  if (wanted.length === 0) return found;

  // A name known for more than a day is still shown, and asked about again:
  // people change their names and pictures, and a screen that only ever read
  // the store would not find out until their profile page was opened.
  try {
    const stored: Map<PubkeyHex, NostrProfile> = await getProfiles(wanted);
    const storedKeys: PubkeyHex[] = Array.from(stored.keys());
    const refresh: boolean[] = await Promise.all(
      // A check that fails says "ask again", for that person only.
      storedKeys.map((pubkey: PubkeyHex) =>
        profileNeedsRefresh(pubkey).catch((): boolean => true),
      ),
    );
    const stale: Set<PubkeyHex> = new Set(
      storedKeys.filter((_, index: number): boolean => refresh[index] === true),
    );
    for (const [pubkey, profile] of stored) {
      found.set(pubkey, profile);
      // Only a current name is remembered: a stale one in memory would be
      // returned for five minutes without the refresh it is due.
      if (stale.has(pubkey)) continue;
      profileMemoryCache.set(pubkey, {
        profile,
        expiresAt: now + PROFILE_MEM_CACHE_TTL_MS,
      });
    }
    wanted = wanted.filter(
      (pubkey: PubkeyHex): boolean => !stored.has(pubkey) || stale.has(pubkey),
    );
  } catch (error: unknown) {
    console.warn('[profile] Profile store could not be read', error);
  }
  if (options.cachedOnly) return found;

  // Someone already asking - an author lookup, an earlier batch - is waited
  // for rather than skipped, or this caller would go without the name.
  const pending: PubkeyHex[] = wanted.filter((pubkey: PubkeyHex): boolean =>
    profileInFlight.has(pubkey),
  );
  // Taken now: by the time this batch is answered, they may have finished
  // and left the map.
  const pendingAnswers: Array<Promise<NostrProfile | null>> = pending.map(
    (pubkey: PubkeyHex) =>
      (profileInFlight.get(pubkey) ?? Promise.resolve(null)).catch(
        (): null => null,
      ),
  );
  wanted = wanted.filter((pubkey: PubkeyHex): boolean => {
    if (profileInFlight.has(pubkey)) return false;
    const last: number | undefined = profileLastAttempt.get(pubkey);
    return !last || now - last >= PROFILE_RETRY_INTERVAL_MS;
  });

  const asking: PubkeyHex[] = relays.length === 0 ? [] : wanted;
  for (const pubkey of asking) profileLastAttempt.set(pubkey, now);

  /** One query per hundred people, all at once; each settles on its own. */
  const askChunk = async (
    chunk: PubkeyHex[],
  ): Promise<Map<PubkeyHex, NostrProfile>> => {
    const fetched: Map<PubkeyHex, NostrProfile> = new Map();
    let events: NostrEvent[] = [];
    try {
      events = await queryRelays(relays, { kinds: [0], authors: chunk });
    } catch (error: unknown) {
      console.warn('[profile] Profiles could not be fetched', error);
      return fetched;
    }
    for (const pubkey of chunk) {
      // The newest copy that reads as a profile: one unreadable edit does not
      // take away the name an older one gives.
      let candidates: NostrEvent[] = events.filter(
        (event: NostrEvent): boolean => event.pubkey === pubkey,
      );
      while (candidates.length > 0) {
        const newest: NostrEvent | null = newestOf(candidates);
        if (!newest) break;
        candidates = candidates.filter((event) => event !== newest);
        let profile: unknown;
        try {
          profile = JSON.parse(newest.content);
        } catch {
          continue;
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          continue;
        }
        const readable: NostrProfile = profile as NostrProfile;
        readable.emojiTags = newest.tags.filter(
          (tag: string[]): boolean => tag[0] === 'emoji',
        );
        // A store that cannot be written does not take the name away: it is
        // still shown, and still remembered for this session.
        try {
          await cacheResolvedProfile(pubkey, readable);
        } catch (error: unknown) {
          console.warn('[profile] Profile could not be stored', error);
          profileMemoryCache.set(pubkey, {
            profile: readable,
            expiresAt: Date.now() + PROFILE_MEM_CACHE_TTL_MS,
          });
        }
        fetched.set(pubkey, readable);
        break;
      }
    }
    return fetched;
  };

  // Registered per person, so a `fetchProfile` for any of them waits on
  // that person's chunk and no other.
  const registered: Map<PubkeyHex, Promise<NostrProfile | null>> = new Map();
  const chunks: Array<Promise<Map<PubkeyHex, NostrProfile>>> = [];
  for (let index = 0; index < asking.length; index += 100) {
    const chunk: PubkeyHex[] = asking.slice(index, index + 100);
    const answer = askChunk(chunk);
    chunks.push(answer);
    for (const pubkey of chunk) {
      const one = answer.then((map) => map.get(pubkey) ?? null);
      registered.set(pubkey, one);
      profileInFlight.set(pubkey, one);
    }
  }
  try {
    for (const map of await Promise.all(chunks)) {
      for (const [pubkey, profile] of map) found.set(pubkey, profile);
    }
  } finally {
    for (const [pubkey, one] of registered) {
      if (profileInFlight.get(pubkey) === one) profileInFlight.delete(pubkey);
    }
  }
  const others: Array<NostrProfile | null> = await Promise.all(pendingAnswers);
  pending.forEach((pubkey: PubkeyHex, index: number): void => {
    const profile: NostrProfile | null | undefined = others[index];
    if (profile) found.set(pubkey, profile);
  });
  return found;
}

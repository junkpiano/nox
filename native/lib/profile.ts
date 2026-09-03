/**
 * One person: their profile and their recent posts.
 *
 * Like the timeline, this sits on the shared relay layer rather than opening
 * its own sockets. The web app's `profile.ts` is 847 lines and builds DOM, so
 * it is not the thing to reuse - but everything underneath it is.
 */

import { storeEvents } from '../../src/common/db/events-store';
import { getProfile, storeProfile } from '../../src/common/db/profiles-store';
import { getCachedTimeline } from '../../src/common/db/timeline-queries';
import { prependEventsToTimeline } from '../../src/common/db/timelines-store';
import type { TimelineKey } from '../../src/common/db/types';
import { queryRelays } from '../../src/common/relay-query';
import { oldestOf, PAGE_LIMIT } from '../../src/common/timeline-paging';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { pictureUrl } from './avatar';

const POST_LIMIT: number = PAGE_LIMIT;

export interface Profile {
  pubkey: PubkeyHex;
  name: string;
  about: string;
  picture: string | null;
  banner: string | null;
  nip05: string | null;
  website: string | null;
}

export interface ProfileResult {
  profile: Profile;
  posts: NostrEvent[];
  /** The question the posts answer, for reading further back. */
  filter: Record<string, unknown>;
  /** The oldest of them, the cursor for the next page. */
  oldestCreatedAt: number | null;
  /** Where the posts live in the cache. */
  cacheKey: TimelineKey;
  /** True for the early result from the cache, before the relays answered. */
  fromCache: boolean;
}

/**
 * Reads a kind 0. The content is a JSON object its owner wrote, so every
 * field is checked for being a string rather than trusted to be one.
 */
function parseProfile(pubkey: PubkeyHex, meta: unknown): Profile {
  const fallback: Profile = {
    pubkey,
    name: `${pubkey.slice(0, 8)}...`,
    about: '',
    picture: null,
    banner: null,
    nip05: null,
    website: null,
  };
  if (!meta || typeof meta !== 'object') return fallback;

  try {
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value : null;
    const fields = meta as Record<string, unknown>;
    return {
      pubkey,
      name: str(fields.display_name) || str(fields.name) || fallback.name,
      about: str(fields.about) ?? '',
      picture: pictureUrl(fields.picture),
      banner: pictureUrl(fields.banner),
      nip05: str(fields.nip05),
      website: str(fields.website),
    };
  } catch {
    return fallback;
  }
}

/** The kind 0's content as the object it claims to be, or null. */
function profileJson(event: NostrEvent | null): NostrProfile | null {
  if (!event) return null;
  try {
    const meta: unknown = JSON.parse(event.content);
    return meta && typeof meta === 'object' ? (meta as NostrProfile) : null;
  } catch {
    return null;
  }
}

export interface LoadProfileOptions {
  /**
   * Called with what the cache held - the person and their recent posts -
   * before the relays are asked. Not called when nothing is cached.
   */
  onCached?: ((result: ProfileResult) => void) | undefined;
}

/** A profile's posts are kept under the person, like the web app keeps them. */
function cacheKeyFor(pubkey: PubkeyHex): TimelineKey {
  return { type: 'user', pubkey };
}

export async function loadProfile(
  pubkey: PubkeyHex,
  options: LoadProfileOptions = {},
): Promise<ProfileResult> {
  const relays: string[] = getRelays();
  const filter: Record<string, unknown> = { kinds: [1], authors: [pubkey] };
  const cacheKey: TimelineKey = cacheKeyFor(pubkey);

  // The cache first: the person as last seen and the posts last fetched,
  // shown while the relays are asked for what has changed.
  let cachedPosts: NostrEvent[] = [];
  if (options.onCached) {
    try {
      const [knownProfile, cachedTimeline] = await Promise.all([
        getProfile(pubkey),
        getCachedTimeline(cacheKey.type, cacheKey.pubkey, {
          limit: POST_LIMIT,
        }),
      ]);
      cachedPosts = cachedTimeline.hasCache ? cachedTimeline.events : [];
      if (knownProfile || cachedPosts.length > 0) {
        options.onCached({
          profile: parseProfile(pubkey, knownProfile),
          posts: cachedPosts,
          filter,
          oldestCreatedAt: oldestOf(cachedPosts),
          cacheKey,
          fromCache: true,
        });
      }
    } catch (error: unknown) {
      console.warn('[profile] cache could not be read', error);
    }
  }

  const [metaEvents, postEvents] = await Promise.all([
    queryRelays(relays, { kinds: [0], authors: [pubkey], limit: 1 }),
    queryRelays(relays, { ...filter, limit: POST_LIMIT }),
  ]);

  // Relays disagree about which revision is current; the newest wins.
  const newest: NostrEvent | null =
    metaEvents.sort(
      (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
    )[0] ?? null;
  const meta: NostrProfile | null = profileJson(newest);
  if (meta) {
    storeProfile(pubkey, meta).catch((): void => {});
  }
  if (postEvents.length > 0) {
    storeEvents(postEvents, { isHomeTimeline: false }).catch((): void => {});
    const newestFirst: NostrEvent[] = [...postEvents].sort(
      (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
    );
    prependEventsToTimeline(
      cacheKey.type,
      cacheKey.pubkey,
      newestFirst.map((event: NostrEvent): string => event.id),
      newestFirst[0]?.created_at ?? 0,
    ).catch((): void => {});
  }

  // What the relays sent and what the cache held, each once, newest first.
  const byId: Map<string, NostrEvent> = new Map();
  for (const event of [...postEvents, ...cachedPosts]) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  const posts: NostrEvent[] = Array.from(byId.values()).sort(
    (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
  );

  return {
    // A relay that has nothing for this person is not a reason to forget
    // the name the cache knew.
    profile: parseProfile(pubkey, meta ?? (await getProfile(pubkey))),
    posts,
    filter,
    oldestCreatedAt: oldestOf(posts),
    cacheKey,
    fromCache: false,
  };
}

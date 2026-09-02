/**
 * The home timeline, on the shared relay layer.
 *
 * The prototype had its own small relay client, which was fine for answering
 * "does a list scroll well". It is not fine here: a second relay client means
 * a second place where NIP-42 AUTH, connection reuse and event verification
 * either happen or quietly do not.
 *
 * So this uses `openRelaySubscription` and `fetchFollowList` from ../../src -
 * the same functions the web app runs - and adds only what is genuinely a
 * front-end concern: which filters to ask for, and what shape the screen wants
 * back.
 */

import {
  type ContentWarning,
  getContentWarning,
} from '../../src/common/content-warning';
import { queryEvents, storeEvents } from '../../src/common/db/events-store';
import { getProfiles, storeProfiles } from '../../src/common/db/profiles-store';
import { getCachedTimeline } from '../../src/common/db/timeline-queries';
import {
  appendEventsToTimeline,
  prependEventsToTimeline,
} from '../../src/common/db/timelines-store';
import type { TimelineKey } from '../../src/common/db/types';
import {
  fetchDeletedIds,
  withoutDeleted,
} from '../../src/common/deleted-events';
import { getCachedDeletionStatus } from '../../src/common/deletion-gate';
import { fetchFollowList } from '../../src/common/events-queries';
import { withoutMachineContent } from '../../src/common/machine-content';
import { filterMutedEvents } from '../../src/common/mute-state';
import { queryRelays } from '../../src/common/relay-query';
import { isRepost, readRepost, unwrapRepost } from '../../src/common/repost';
import { oldestOf, PAGE_LIMIT } from '../../src/common/timeline-paging';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';

/** Kinds the home timeline shows. Mirrors `homeKinds` in the web app. */
const HOME_KINDS: number[] = [1, 6];

/** Relays reject enormous `authors` lists, and this is plenty of timeline. */
const MAX_AUTHORS: number = 300;
/** The first load is one page; the rest come as the list is scrolled. */
const POST_LIMIT: number = PAGE_LIMIT;
/** A poll for newer posts is small; anything more is a reload. */
const NEWER_LIMIT: number = 100;

export interface TimelinePost {
  /**
   * Stable across the list, which the reposted event's id is not: two people
   * reposting the same note, or a repost of something already on screen,
   * would collide.
   */
  key: string;
  id: string;
  pubkey: PubkeyHex;
  createdAt: number;
  content: string;
  kind: number;
  name: string;
  picture: string | null;
  nip05: string | null;
  /** NIP-36, as the author set it. Never inferred from the text. */
  warning: ContentWarning;
  /**
   * The event as it arrived.
   *
   * Carried because a repost has to embed the whole thing (NIP-18 puts it in
   * `content`), and rebuilding it from the flattened row would mean inventing
   * the tags and the signature.
   */
  event: NostrEvent;
  /**
   * Who reposted this, when the row is a repost.
   *
   * NIP-18 puts the whole reposted event as JSON in the kind 6's `content`,
   * so a card that renders `content` shows a wall of `{"id":"..."}`. The row
   * carries the reposted event and says who passed it on.
   */
  repostedBy: { pubkey: PubkeyHex; name: string } | null;
  /**
   * Set when a repost carried no readable copy of its target - only the `e`
   * tag. The card fetches it, the way it fetches a quote, instead of showing
   * the nothing that used to be here.
   */
  repostTargetId: string | null;
}

export interface TimelineResult {
  posts: TimelinePost[];
  /**
   * The question the relays were asked, without `limit` or `since`, so a
   * later poll for newer posts can ask the same one from a later moment.
   */
  filter: Record<string, unknown>;
  /**
   * The oldest raw event this load brought back - the cursor for reading
   * further. Raw rather than shown: a repost's own time is what the relay
   * filtered on, not the time of the note inside it.
   */
  oldestCreatedAt: number | null;
  /** Where this timeline lives in the cache; null for one that is not kept. */
  cacheKey: TimelineKey | null;
  stats: {
    follows: number;
    events: number;
    profiles: number;
    relays: number;
    ms: number;
    /** How many events the mute list removed, so the filter is visible. */
    muted: number;
  };
}

export interface ProfileMeta {
  name: string;
  picture: string | null;
  nip05: string | null;
}

export interface LoadOptions {
  /**
   * Called with what the cache held, decorated without the network, before
   * the relays are asked - so the screen has something to show in the time
   * the relays take. Not called when the cache is empty or too old.
   */
  onCached?: ((posts: TimelinePost[]) => void) | undefined;
}

/**
 * How old a cached timeline may be and still be worth showing first. The
 * web app's numbers: a following timeline changes slowly, the global one
 * does not.
 */
const CACHE_MAX_AGE_MINUTES: Record<TimelineKey['type'], number> = {
  home: 30,
  global: 10,
  user: 30,
};

/**
 * What the cache holds for a timeline, shown before the relays are asked.
 *
 * Decorated from the cache alone - names and faces from the profile store,
 * withdrawals from what this session already knows - so nothing here waits
 * on a socket. Returns the raw events so the relay phase can judge them
 * properly and keep them if they are still good.
 */
async function showFromCache(
  key: TimelineKey,
  relays: string[],
  onCached: LoadOptions['onCached'],
): Promise<NostrEvent[]> {
  if (!onCached) return [];
  try {
    const cached = await getCachedTimeline(key.type, key.pubkey, {
      limit: PAGE_LIMIT,
    });
    if (!cached.hasCache || cached.events.length === 0) return [];
    const ageMinutes: number =
      (Date.now() / 1000 - cached.newestTimestamp) / 60;
    if (ageMinutes > CACHE_MAX_AGE_MINUTES[key.type]) return [];
    const decorated: Decorated = await decorateEvents(relays, cached.events, {
      profiles: 'cached',
      deletions: 'remembered',
    });
    if (decorated.posts.length > 0) onCached(decorated.posts);
    return cached.events;
  } catch (error: unknown) {
    console.warn('[timeline] cache could not be read', error);
    return [];
  }
}

/** Tells the cache what the relays sent, so the next launch starts from it. */
function rememberTimeline(key: TimelineKey, events: NostrEvent[]): void {
  if (events.length === 0) return;
  const newestFirst: NostrEvent[] = [...events].sort(
    (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
  );
  storeEvents(events, { isHomeTimeline: key.type === 'home' }).catch(
    (): void => {},
  );
  prependEventsToTimeline(
    key.type,
    key.pubkey,
    newestFirst.map((event: NostrEvent): string => event.id),
    newestFirst[0]?.created_at ?? 0,
  ).catch((): void => {});
}

/** The two runs as one, each event once. */
function union(a: NostrEvent[], b: NostrEvent[]): NostrEvent[] {
  const byId: Map<string, NostrEvent> = new Map();
  for (const event of [...a, ...b]) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return Array.from(byId.values());
}

export async function loadHomeTimeline(
  viewer: PubkeyHex,
  onStage: (stage: string) => void,
  options: LoadOptions = {},
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();
  const cacheKey: TimelineKey = { type: 'home', pubkey: viewer };
  const cachedEvents: NostrEvent[] = await showFromCache(
    cacheKey,
    relays,
    options.onCached,
  );

  onStage('follow list...');
  const follows: PubkeyHex[] = await fetchFollowList(viewer, relays);
  // Seeing your own posts in your own timeline is the web app's behaviour too.
  const authors: PubkeyHex[] = Array.from(new Set([viewer, ...follows])).slice(
    0,
    MAX_AUTHORS,
  );

  onStage(`posts from ${authors.length} people...`);
  const filter: Record<string, unknown> = { kinds: HOME_KINDS, authors };
  const fetched: NostrEvent[] = await queryRelays(relays, {
    ...filter,
    limit: POST_LIMIT,
  });
  rememberTimeline(cacheKey, fetched);
  const events: NostrEvent[] = union(fetched, cachedEvents);

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
    filter,
    oldestCreatedAt: oldestOf(events),
    cacheKey,
    stats: {
      follows: follows.length,
      events: events.length,
      profiles: decorated.profileCount,
      relays: relays.length,
      ms: Date.now() - started,
      muted: events.length - filterMutedEvents(events).length,
    },
  };
}

/**
 * Attaches an author to each event, newest profile revision winning.
 *
 * Relays disagree about which kind 0 is current, so the copy with the latest
 * `created_at` is the one shown - the same rule the web app applies.
 */
interface Decorated {
  posts: TimelinePost[];
  /** How many distinct authors a kind 0 was actually found for. */
  profileCount: number;
}

/**
 * Names and faces for a set of pubkeys, newest kind 0 winning.
 *
 * Exported because a conversation list needs exactly this and nothing else
 * from the timeline. Relays disagree about which kind 0 is current, so the
 * copy with the latest `created_at` is the one kept - the rule the web app
 * applies, applied once here rather than per caller.
 */
export async function fetchProfilesForPubkeys(
  pubkeys: PubkeyHex[],
  relays: string[] = getRelays(),
  mode: 'cached' | 'cached-then-relays' = 'cached-then-relays',
): Promise<Map<string, ProfileMeta>> {
  const wanted: PubkeyHex[] = Array.from(new Set(pubkeys)).slice(
    0,
    MAX_AUTHORS,
  );
  const profiles: Map<string, ProfileMeta> = new Map();
  if (wanted.length === 0) {
    return profiles;
  }

  // The profile store first: a name that was known yesterday is still the
  // name, and asking a relay for it again is what made every load wait on
  // a kind 0 query for a hundred people.
  try {
    const known: Map<PubkeyHex, NostrProfile> = await getProfiles(wanted);
    for (const [pubkey, profile] of known) {
      const meta: ProfileMeta | null = metaFrom(profile);
      if (meta) profiles.set(pubkey, meta);
    }
  } catch (error: unknown) {
    console.warn('[timeline] profile cache could not be read', error);
  }

  const missing: PubkeyHex[] = wanted.filter(
    (pubkey: PubkeyHex): boolean => !profiles.has(pubkey),
  );
  if (mode === 'cached' || missing.length === 0) {
    return profiles;
  }

  const profileEvents: NostrEvent[] = await queryRelays(relays, {
    kinds: [0],
    authors: missing,
  });

  const profileAt: Map<string, number> = new Map();
  const fetched: Map<PubkeyHex, NostrProfile> = new Map();
  for (const event of profileEvents) {
    const previous: number | undefined = profileAt.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) continue;
    const raw: NostrProfile | null = profileJson(event);
    const meta: ProfileMeta | null = raw ? metaFrom(raw) : null;
    if (!raw || !meta) continue;
    profiles.set(event.pubkey, meta);
    fetched.set(event.pubkey as PubkeyHex, raw);
    profileAt.set(event.pubkey, event.created_at);
  }
  if (fetched.size > 0) {
    storeProfiles(
      Array.from(fetched, ([pubkey, profile]) => ({ pubkey, profile })),
    ).catch((): void => {});
  }

  return profiles;
}

/** The kind 0's content as the object it claims to be, or null. */
function profileJson(event: NostrEvent): NostrProfile | null {
  try {
    const meta: unknown = JSON.parse(event.content);
    return meta && typeof meta === 'object' ? (meta as NostrProfile) : null;
  } catch {
    return null;
  }
}

/** What the card needs from a profile, whichever way it arrived. */
function metaFrom(meta: NostrProfile): ProfileMeta | null {
  return {
    name: meta.display_name || meta.name || '',
    picture: typeof meta.picture === 'string' ? meta.picture : null,
    nip05: typeof meta.nip05 === 'string' ? meta.nip05 : null,
  };
}

/**
 * Turns events into rows, with authors attached.
 *
 * Exported because a profile is a timeline. It had its own stripped-down
 * renderer - no avatar, no time, no actions, no pictures - for no reason
 * beyond having been written second.
 */

export interface DecorateOptions {
  /** Whether missing names may be fetched, or only what the store has. */
  profiles?: 'cached' | 'cached-then-relays' | undefined;
  /**
   * Whether to ask the relays about withdrawals, or only use what this
   * session already learned. The cached first paint takes the latter; the
   * relays are asked once the real load arrives.
   */
  deletions?: 'ask' | 'remembered' | undefined;
}

export async function decorateEvents(
  relays: string[],
  events: NostrEvent[],
  options: DecorateOptions = {},
): Promise<Decorated> {
  // Withdrawn posts leave before anything else is done with them, so a
  // deleted post is not fetched a profile for or counted in the stats.
  // Silence from every relay is not an answer: the batch is shown unjudged
  // rather than not at all, and asked about again with the next load.
  let deleted: Set<string> = new Set();
  if (options.deletions === 'remembered') {
    for (const event of events) {
      if (getCachedDeletionStatus(event.id) === true) deleted.add(event.id);
    }
  } else {
    try {
      deleted = await fetchDeletedIds(relays, events);
    } catch (error: unknown) {
      console.warn('[timeline] deletions could not be checked', error);
    }
  }
  // Machine output - a note whose whole body is a JSON object - is judged
  // on what would be shown, so a repost of a heartbeat goes with it.
  // The mute list was counted in the stats and never applied to the rows:
  // a muted author's posts were on screen under a line saying they were
  // hidden. Judged on both sides of a repost - the author, and whoever
  // passed it on - since muting either is a reason not to see it.
  const live: NostrEvent[] = withoutDeleted(events, deleted).filter(
    (event: NostrEvent): boolean => {
      const shown: NostrEvent = unwrapRepost(event).event ?? event;
      const judged: NostrEvent[] = shown === event ? [event] : [event, shown];
      if (filterMutedEvents(judged).length !== judged.length) return false;
      return withoutMachineContent([shown]).length === 1;
    },
  );

  // Both the author and, for a repost, whoever passed it on: the card names
  // them both and a missing name is a hex string on screen.
  const authors: PubkeyHex[] = live.flatMap(
    (event: NostrEvent): PubkeyHex[] => {
      const reposted: NostrEvent | null = isRepost(event)
        ? readRepost(event).event
        : null;
      return reposted
        ? [event.pubkey as PubkeyHex, reposted.pubkey as PubkeyHex]
        : [event.pubkey as PubkeyHex];
    },
  );
  const profiles: Map<string, ProfileMeta> = await fetchProfilesForPubkeys(
    authors,
    relays,
    options.profiles ?? 'cached-then-relays',
  );

  const posts: TimelinePost[] = live
    .slice()
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at)
    .map((event: NostrEvent): TimelinePost => {
      // A repost is a wrapper. What the card shows, and what a like or a
      // reply is addressed to, is the event inside it.
      const unwrapped = unwrapRepost(event);
      const reposted: NostrEvent | null = isRepost(event)
        ? unwrapped.event
        : null;
      const shown: NostrEvent = reposted ?? event;
      const meta: ProfileMeta | undefined = profiles.get(shown.pubkey);
      const sharer: ProfileMeta | undefined = profiles.get(event.pubkey);

      return {
        key: event.id,
        id: shown.id,
        pubkey: shown.pubkey as PubkeyHex,
        createdAt: shown.created_at,
        // An unreadable repost - no embedded copy, or a copy that is not an
        // event - shows as an empty card rather than as its own JSON.
        content: reposted || !isRepost(event) ? shown.content : '',
        kind: shown.kind,
        name: meta?.name || `${shown.pubkey.slice(0, 8)}...`,
        picture: meta?.picture ?? null,
        nip05: meta?.nip05 ?? null,
        warning: getContentWarning(shown),
        event: shown,
        repostedBy: isRepost(event)
          ? {
              pubkey: event.pubkey as PubkeyHex,
              name: sharer?.name || `${event.pubkey.slice(0, 8)}...`,
            }
          : null,
        repostTargetId:
          isRepost(event) && !unwrapped.event ? unwrapped.targetId : null,
      };
    });

  return { posts, profileCount: profiles.size };
}

/**
 * The global timeline: the same shape, without an author filter.
 *
 * No follow list is fetched, because there is nobody in particular to follow -
 * this is whatever the configured relays happen to be carrying. A `since`
 * bound keeps it to the recent past rather than letting each relay decide for
 * itself how far back `limit` should reach.
 */
/**
 * Posts carrying a hashtag.
 *
 * NIP-12 indexes these as `t` tags, lowercased, so the filter is exact rather
 * than a text search - which is why a tag is worth linking at all: it goes
 * somewhere the relays can actually answer.
 */
export async function loadHashtagTimeline(
  tag: string,
  onStage: (stage: string) => void,
  _options: LoadOptions = {},
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();

  onStage(`#${tag}...`);
  const filter: Record<string, unknown> = {
    kinds: [1],
    '#t': [tag.toLowerCase()],
  };
  const events: NostrEvent[] = await queryRelays(relays, {
    ...filter,
    limit: POST_LIMIT,
  });

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
    filter,
    oldestCreatedAt: oldestOf(events),
    // A tag is a question the cache is not indexed to answer.
    cacheKey: null,
    stats: {
      follows: 0,
      events: events.length,
      profiles: decorated.profileCount,
      relays: relays.length,
      ms: Date.now() - started,
      muted: events.length - filterMutedEvents(events).length,
    },
  };
}

/**
 * Posts newer than the ones on screen, in the timeline's own shape.
 *
 * Asked with the timeline's own filter from one second past its newest post,
 * so a relay sends only what it has not already sent. Muted, deleted and
 * machine-written posts leave here as they do on a full load, so what comes
 * back is what a row saying "12 new posts" will actually add.
 */
export async function loadNewerPosts(
  filter: Record<string, unknown>,
  since: number,
): Promise<TimelinePost[]> {
  const relays: string[] = getRelays();
  const events: NostrEvent[] = await queryRelays(relays, {
    ...filter,
    since,
    limit: NEWER_LIMIT,
  });
  if (events.length === 0) return [];
  const decorated: Decorated = await decorateEvents(relays, events);
  return decorated.posts;
}

/**
 * The page before `until`, in the timeline's own shape.
 *
 * Cache first: the main event cache is asked for the range, and the relays
 * only for what it could not supply. What the relays send is written back
 * to that cache. Muted, withdrawn and machine-written posts leave here as
 * they do on the first load - there is one decoration path, not a lighter
 * one for pages - and the raw events come back too, because the cursor and
 * the end of the timeline are judged on those rather than on what survived.
 */
export async function loadOlderPosts(
  filter: Record<string, unknown>,
  until: number,
  cacheKey: TimelineKey | null = null,
): Promise<{ posts: TimelinePost[]; raw: NostrEvent[] }> {
  const relays: string[] = getRelays();

  const cached: NostrEvent[] = await readOlderFromCache(filter, until);
  const byId: Map<string, NostrEvent> = new Map(
    cached.map((event: NostrEvent): [string, NostrEvent] => [event.id, event]),
  );
  if (cached.length < PAGE_LIMIT) {
    const remote: NostrEvent[] = await queryRelays(relays, {
      ...filter,
      until,
      limit: PAGE_LIMIT,
    });
    for (const event of remote) {
      if (!byId.has(event.id)) byId.set(event.id, event);
    }
    if (remote.length > 0) {
      storeEvents(remote, {
        isHomeTimeline: cacheKey?.type === 'home',
      }).catch((): void => {
        // A cache that cannot be written is a slower next time, not an error.
      });
      if (cacheKey) {
        const oldestFirst: NostrEvent[] = [...remote].sort(
          (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
        );
        appendEventsToTimeline(
          cacheKey.type,
          cacheKey.pubkey,
          oldestFirst.map((event: NostrEvent): string => event.id),
          oldestOf(remote) ?? until,
        ).catch((): void => {});
      }
    }
  }

  const raw: NostrEvent[] = Array.from(byId.values());
  if (raw.length === 0) return { posts: [], raw };
  const decorated: Decorated = await decorateEvents(relays, raw);
  return { posts: decorated.posts, raw };
}

/**
 * What the main cache holds for this page. A tag filter is a question the
 * cache is not indexed to answer, so it is passed straight to the relays.
 */
async function readOlderFromCache(
  filter: Record<string, unknown>,
  until: number,
): Promise<NostrEvent[]> {
  if ('#t' in filter) return [];
  const kinds: number[] | undefined = Array.isArray(filter.kinds)
    ? (filter.kinds as number[])
    : undefined;
  const authors: PubkeyHex[] | undefined = Array.isArray(filter.authors)
    ? (filter.authors as PubkeyHex[])
    : undefined;
  try {
    return await queryEvents({
      ...(kinds ? { kinds } : {}),
      ...(authors ? { authors } : {}),
      until,
      limit: PAGE_LIMIT,
    });
  } catch {
    return [];
  }
}

export async function loadGlobalTimeline(
  onStage: (stage: string) => void,
  options: LoadOptions = {},
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();
  const sinceHours: number = 6;
  const cacheKey: TimelineKey = { type: 'global' };
  const cachedEvents: NostrEvent[] = await showFromCache(
    cacheKey,
    relays,
    options.onCached,
  );

  onStage('recent posts...');
  const filter: Record<string, unknown> = { kinds: HOME_KINDS };
  const fetched: NostrEvent[] = await queryRelays(relays, {
    ...filter,
    since: Math.floor(Date.now() / 1000) - sinceHours * 3600,
    limit: POST_LIMIT,
  });
  rememberTimeline(cacheKey, fetched);
  const events: NostrEvent[] = union(fetched, cachedEvents);

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
    filter,
    oldestCreatedAt: oldestOf(events),
    cacheKey,
    stats: {
      follows: 0,
      events: events.length,
      profiles: decorated.profileCount,
      relays: relays.length,
      ms: Date.now() - started,
      muted: events.length - filterMutedEvents(events).length,
    },
  };
}

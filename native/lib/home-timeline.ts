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

import { emitAppEvent } from '../../src/common/app-events';
import { readClientName } from '../../src/common/client-tag';
import type { EmojiMap } from '../../src/common/content-segments';
import {
  type ContentWarning,
  getContentWarning,
} from '../../src/common/content-warning';
import {
  deleteEvents,
  queryEvents,
  storeEvents,
} from '../../src/common/db/events-store';
import { getCachedTimeline } from '../../src/common/db/timeline-queries';
import {
  appendEventsToTimeline,
  prependEventsToTimeline,
  removeEventFromTimeline,
} from '../../src/common/db/timelines-store';
import type { TimelineKey } from '../../src/common/db/types';
import {
  findDeletedIds,
  getCachedDeletionStatus,
} from '../../src/common/deletion-gate';
import { matchesFilter } from '../../src/common/event-filter';
import { rememberedFollows } from '../../src/common/events-queries';
import {
  getFollowedHashtags,
  homeFilters,
  refreshFollowedHashtags,
} from '../../src/common/interests';
import { filterMutedEvents } from '../../src/common/mute-state';
import { fetchFollowSet } from '../../src/common/notification-filter';
import { queryRelays, queryRelaysAny } from '../../src/common/relay-query';
import { showableEvents } from '../../src/common/showable';

/** What a timeline asks: one filter, or several ORed as one REQ would. */
export type TimelineFilter =
  | Record<string, unknown>
  | Array<Record<string, unknown>>;

import { FEED_KINDS, hashtagFeedFilter } from '../../src/common/feeds';
import { fetchProfiles } from '../../src/common/profile-fetch';
import {
  checkRepostNotes,
  isRepost,
  readRepost,
  unwrapRepost,
} from '../../src/common/repost';
import { oldestOf, PAGE_LIMIT } from '../../src/common/timeline-paging';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { customEmojiOf, pictureUrl } from './avatar';

/** Kinds the home timeline shows. Mirrors `homeKinds` in the web app. */

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
  /** NIP-30: the pictures the author put in their own name. */
  nameEmoji: EmojiMap;
  picture: string | null;
  nip05: string | null;
  /** NIP-36, as the author set it. Never inferred from the text. */
  warning: ContentWarning;
  /**
   * NIP-89: the client the author says they posted from, already cut to
   * one short line by the shared reader. Null when the event does not say.
   */
  client: string | null;
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
  repostedBy: {
    pubkey: PubkeyHex;
    name: string;
    emoji: EmojiMap;
  } | null;
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
  filter: TimelineFilter;
  /**
   * The oldest raw event this load brought back - the cursor for reading
   * further. Raw rather than shown: a repost's own time is what the relay
   * filtered on, not the time of the note inside it.
   */
  oldestCreatedAt: number | null;
  /** Where this timeline lives in the cache; null for one that is not kept. */
  cacheKey: TimelineKey | null;
  stats: {
    /** How many people the follow list named; null when no list was read. */
    follows: number | null;
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
  /** NIP-30: the pictures this person put in their own name. */
  emoji: EmojiMap;
}

export interface LoadOptions {
  /**
   * Called with what the cache held, decorated without the network, before
   * the relays are asked - so the screen has something to show in the time
   * the relays take. Not called when the cache is empty or too old.
   */
  onCached?: ((posts: TimelinePost[]) => void) | undefined;
  /**
   * Called with the posts the relays just sent, dressed from what is
   * already known and without asking anyone anything. The names and the
   * withdrawal check are two more round trips; the posts are in hand
   * before them, and a screen that waits for them reads as stalled.
   */
  onFetched?: ((posts: TimelinePost[]) => void) | undefined;
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
  keep: (event: NostrEvent) => boolean = (): boolean => true,
): Promise<NostrEvent[]> {
  if (!onCached) return [];
  try {
    const cached = await getCachedTimeline(key.type, key.pubkey, {
      limit: PAGE_LIMIT,
    });
    const kept: NostrEvent[] = cached.events.filter(keep);
    if (!cached.hasCache || kept.length === 0) return [];
    // Since it was saved, not since its newest post: people who post
    // rarely would otherwise never have their timeline shown from cache.
    const ageMinutes: number = (Date.now() - cached.savedAt) / 60000;
    if (ageMinutes > CACHE_MAX_AGE_MINUTES[key.type]) return [];
    const decorated: Decorated = await decorateEvents(relays, kept, {
      profiles: 'cached',
      deletions: 'remembered',
      cacheKey: key,
    });
    if (decorated.posts.length > 0) onCached(decorated.posts);
    return kept;
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
  // The list this device remembers starts the timeline at once; the relays'
  // is asked for alongside, and Home reloads only if it turns out different.
  const remembered: PubkeyHex[] | null = rememberedFollows(viewer);
  // Cached posts that no longer answer Home's question - by someone
  // unfollowed, under a hashtag dropped - stay off screen, whenever the cache
  // was written and whatever was still in flight when it was.
  const remembers: Array<Record<string, unknown>> = homeFilters(
    FEED_KINDS,
    [viewer, ...(remembered ?? [])],
    getFollowedHashtags(viewer),
  );
  // Without a remembered list there is no telling which cached posts still
  // belong, so that one load - the first after install - waits for the relays.
  const followed = (event: NostrEvent): boolean =>
    remembered !== null &&
    remembers.some((one): boolean => matchesFilter(one, event));
  const cachedEvents: NostrEvent[] = await showFromCache(
    cacheKey,
    relays,
    options.onCached,
    followed,
  );

  onStage('follow list...');
  // The shared reader: silence from every relay is an error, and relays
  // that answered without a list give null - neither is "follows nobody".
  const asked: Promise<Set<PubkeyHex> | null> = fetchFollowSet(viewer, relays);
  // Announces its own change, which reloads Home.
  const refreshed: Promise<string[]> = refreshFollowedHashtags(
    viewer,
    relays,
  ).catch((): string[] => getFollowedHashtags(viewer));
  let followSet: Set<PubkeyHex> | null;
  let hashtags: string[];
  if (remembered) {
    followSet = new Set(remembered);
    hashtags = getFollowedHashtags(viewer);
    void asked
      .then((): void => {
        // What the device now keeps: an older list on a relay is not kept,
        // and comparing against it would reload Home over and over.
        const now: PubkeyHex[] | null = rememberedFollows(viewer);
        if (now && [...now].sort().join() !== [...remembered].sort().join()) {
          emitAppEvent('follows-updated');
        }
      })
      .catch((): void => {});
  } else {
    // Nothing remembered yet: the first load waits for both.
    [followSet, hashtags] = await Promise.all([asked, refreshed]);
  }
  const follows: PubkeyHex[] = followSet ? Array.from(followSet) : [];
  // Seeing your own posts in your own timeline is the web app's behaviour too.
  const authors: PubkeyHex[] = Array.from(new Set([viewer, ...follows])).slice(
    0,
    MAX_AUTHORS,
  );

  onStage(`posts from ${authors.length} people...`);
  const filter: Array<Record<string, unknown>> = homeFilters(
    FEED_KINDS,
    authors,
    hashtags,
  );
  const fetched: NostrEvent[] = await queryRelaysAny(relays, filter, {
    limit: POST_LIMIT,
  });
  rememberTimeline(cacheKey, fetched);
  // Only what the current question admits: a hashtag since unfollowed,
  // or a person, leaves with it.
  const events: NostrEvent[] = union(
    fetched,
    cachedEvents.filter(
      (event: NostrEvent): boolean =>
        filter.some((one): boolean => matchesFilter(one, event)) &&
        // Below the fetched page lies what the relays have not sent yet; cached
        // posts there would carry the cursor past it. Paging fetches them.
        (fetched.length === 0 || event.created_at >= (oldestOf(fetched) ?? 0)),
    ),
  );

  if (options.onFetched) {
    try {
      const quick: Decorated = await decorateEvents(relays, events, {
        profiles: 'cached',
        deletions: 'remembered',
        cacheKey,
      });
      options.onFetched(quick.posts);
    } catch (error: unknown) {
      console.warn('[timeline] the first paint could not be dressed', error);
    }
  }

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events, {
    cacheKey,
  });

  return {
    posts: decorated.posts,
    filter,
    oldestCreatedAt: oldestOf(events),
    cacheKey,
    stats: {
      follows: followSet ? followSet.size : null,
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

  // The shared lookup: memory, then the store, then the relays for anyone
  // missing or known for more than a day, a hundred to a query.
  const known: Map<PubkeyHex, NostrProfile> = await fetchProfiles(
    wanted,
    relays,
    { cachedOnly: mode === 'cached' },
  );
  for (const [pubkey, profile] of known) {
    const meta: ProfileMeta | null = metaFrom(profile);
    if (meta) profiles.set(pubkey, meta);
  }
  return profiles;
}

/** What the card needs from a profile, whichever way it arrived. */
/** One empty map, shared: a name without emoji is the usual case. */
const EMPTY_EMOJI: EmojiMap = new Map();

/** A field somebody else wrote is a string only if it is one. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * What the row needs from a profile.
 *
 * The emoji come from the kind 0's own `emoji` tags, kept on the parsed
 * profile as `emojiTags` - the shape the web already stores - because a
 * name is drawn long after its event has been forgotten.
 */
function metaFrom(meta: NostrProfile): ProfileMeta | null {
  return {
    name: str(meta.display_name) || str(meta.name),
    picture: pictureUrl(meta.picture),
    nip05: typeof meta.nip05 === 'string' ? meta.nip05 : null,
    emoji: customEmojiOf(
      Array.isArray(meta.emojiTags) ? (meta.emojiTags as string[][]) : [],
    ),
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
  /**
   * Where these events live in the cache, so one that turns out withdrawn
   * is removed there too. Without this the cache would hand it back on the
   * next launch, to be shown for a second and then taken away again.
   */
  cacheKey?: TimelineKey | null | undefined;
}

/** A withdrawn post leaves the cache, or the next launch shows it again. */
function forgetWithdrawn(ids: string[], key: TimelineKey | null): void {
  if (ids.length === 0) return;
  deleteEvents(ids).catch((): void => {});
  if (!key) return;
  for (const id of ids) {
    removeEventFromTimeline(key.type, key.pubkey, id).catch((): void => {});
  }
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
  // Asked through the shared gate, so what is learned is remembered for the
  // session - the cached first paint of the next screen reads that memory.
  //
  // Asked at the same time as the names below. They are independent
  // questions - one says which posts to drop, the other what to call the
  // people in them - and every relay query waits out a grace period for
  // the slower relays, so asking them in turn paid that wait twice. The
  // names of a post that turns out to be withdrawn are simply unused.
  const deletionsAnswer: Promise<Set<string>> =
    options.deletions === 'remembered'
      ? Promise.resolve(
          new Set(
            events
              .filter(
                (event: NostrEvent): boolean =>
                  getCachedDeletionStatus(event.id) === true,
              )
              .map((event: NostrEvent): string => event.id),
          ),
        )
      : findDeletedIds(relays, events).catch((error: unknown): Set<string> => {
          console.warn('[timeline] deletions could not be checked', error);
          return new Set();
        });

  await checkRepostNotes(events);

  // Both the author and, for a repost, whoever passed it on: the card names
  // them both and a missing name is a hex string on screen. Taken from
  // every event rather than the survivors, because the question goes out
  // before the withdrawals are known.
  const allAuthors: PubkeyHex[] = events.flatMap(
    (event: NostrEvent): PubkeyHex[] => {
      const reposted: NostrEvent | null = isRepost(event)
        ? readRepost(event).event
        : null;
      return reposted
        ? [event.pubkey as PubkeyHex, reposted.pubkey as PubkeyHex]
        : [event.pubkey as PubkeyHex];
    },
  );
  const [deleted, profiles]: [Set<string>, Map<string, ProfileMeta>] =
    await Promise.all([
      deletionsAnswer,
      fetchProfilesForPubkeys(
        allAuthors,
        relays,
        options.profiles ?? 'cached-then-relays',
      ),
    ]);
  forgetWithdrawn(Array.from(deleted), options.cacheKey ?? null);
  // The rule the web applies too: mutes on both sides of a repost, machine
  // output judged on what would be shown.
  const live: NostrEvent[] = showableEvents(events, deleted);

  // The question above went out before the withdrawals were known, so it
  // carried every author and may have hit the cap on a large batch. Anyone
  // still standing who was cut off is asked about now - a small question,
  // and only when the cap actually bit.
  const asked: Set<string> = new Set(
    Array.from(new Set(allAuthors)).slice(0, MAX_AUTHORS),
  );
  const missing: PubkeyHex[] = Array.from(
    new Set(
      live.flatMap((event: NostrEvent): PubkeyHex[] => {
        const reposted: NostrEvent | null = isRepost(event)
          ? readRepost(event).event
          : null;
        const named: PubkeyHex[] = reposted
          ? [event.pubkey as PubkeyHex, reposted.pubkey as PubkeyHex]
          : [event.pubkey as PubkeyHex];
        // Only those the cap cut off. Somebody with no kind 0 at all was
        // asked about and simply has none; asking again would repeat a
        // question that has already been answered with silence.
        return named.filter((pubkey: PubkeyHex): boolean => !asked.has(pubkey));
      }),
    ),
  );
  if (missing.length > 0) {
    const late: Map<string, ProfileMeta> = await fetchProfilesForPubkeys(
      missing,
      relays,
      options.profiles ?? 'cached-then-relays',
    );
    for (const [pubkey, meta] of late) profiles.set(pubkey, meta);
  }

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
        nameEmoji: meta?.emoji ?? EMPTY_EMOJI,
        picture: meta?.picture ?? null,
        nip05: meta?.nip05 ?? null,
        warning: getContentWarning(shown),
        client: readClientName(shown.tags),
        event: shown,
        repostedBy: isRepost(event)
          ? {
              pubkey: event.pubkey as PubkeyHex,
              name: sharer?.name || `${event.pubkey.slice(0, 8)}...`,
              emoji: sharer?.emoji ?? EMPTY_EMOJI,
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
  const filter: Record<string, unknown> = hashtagFeedFilter(tag);
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
      follows: null,
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
  filter: TimelineFilter,
  since: number,
): Promise<TimelinePost[]> {
  const relays: string[] = getRelays();
  const events: NostrEvent[] = await queryRelaysAny(relays, filter, {
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
  filter: TimelineFilter,
  until: number,
  cacheKey: TimelineKey | null = null,
): Promise<{ posts: TimelinePost[]; raw: NostrEvent[] }> {
  const relays: string[] = getRelays();

  const cached: NostrEvent[] = await readOlderFromCache(filter, until);
  const byId: Map<string, NostrEvent> = new Map(
    cached.map((event: NostrEvent): [string, NostrEvent] => [event.id, event]),
  );
  if (cached.length < PAGE_LIMIT) {
    const remote: NostrEvent[] = await queryRelaysAny(relays, filter, {
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
  const decorated: Decorated = await decorateEvents(relays, raw, { cacheKey });
  return { posts: decorated.posts, raw };
}

/**
 * What the main cache holds for this page. A tag filter is a question the
 * cache is not indexed to answer, so it is passed straight to the relays.
 */
async function readOlderFromCache(
  filters: TimelineFilter,
  until: number,
): Promise<NostrEvent[]> {
  // ponytail: Home with followed hashtags pages from the relays alone; read
  // the authors part from the cache too if older pages feel slow.
  if (Array.isArray(filters) && filters.length !== 1) return [];
  const filter: Record<string, unknown> = Array.isArray(filters)
    ? (filters[0] ?? {})
    : filters;
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
  const filter: Record<string, unknown> = { kinds: FEED_KINDS };
  const fetched: NostrEvent[] = await queryRelays(relays, {
    ...filter,
    since: Math.floor(Date.now() / 1000) - sinceHours * 3600,
    limit: POST_LIMIT,
  });
  rememberTimeline(cacheKey, fetched);
  const events: NostrEvent[] = union(fetched, cachedEvents);

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events, {
    cacheKey,
  });

  return {
    posts: decorated.posts,
    filter,
    oldestCreatedAt: oldestOf(events),
    cacheKey,
    stats: {
      follows: null,
      events: events.length,
      profiles: decorated.profileCount,
      relays: relays.length,
      ms: Date.now() - started,
      muted: events.length - filterMutedEvents(events).length,
    },
  };
}

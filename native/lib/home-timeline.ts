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
import {
  collectDeletedIds,
  DELETION_KIND,
  withoutDeleted,
} from '../../src/common/deleted-events';
import { fetchFollowList } from '../../src/common/events-queries';
import { filterMutedEvents } from '../../src/common/mute-state';
import { openRelaySubscription } from '../../src/common/relay-socket';
import { isRepost, readRepost } from '../../src/common/repost';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';

/** Kinds the home timeline shows. Mirrors `homeKinds` in the web app. */
const HOME_KINDS: number[] = [1, 6];

/** Relays reject enormous `authors` lists, and this is plenty of timeline. */
const MAX_AUTHORS: number = 300;
const POST_LIMIT: number = 400;
const QUERY_TIMEOUT_MS: number = 9000;

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
}

export interface TimelineResult {
  posts: TimelinePost[];
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

/**
 * Runs one filter across every relay and collects what comes back.
 *
 * Resolves when every relay has sent EOSE or the timeout expires. A relay that
 * never answers costs the timeout and nothing else - the others are not held
 * up waiting for it.
 */
export function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve) => {
    const byId: Map<string, NostrEvent> = new Map();
    const unsubscribes: Array<() => void> = [];
    let done: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of unsubscribes) {
        try {
          stop();
        } catch {
          // A subscription that is already gone is not a problem.
        }
      }
      resolve(Array.from(byId.values()));
    };

    const timer = setTimeout(finish, QUERY_TIMEOUT_MS);

    const oneDone = (): void => {
      done += 1;
      if (done >= relays.length) finish();
    };

    for (const relayUrl of relays) {
      openRelaySubscription(relayUrl, filter, {
        onEvent: (event: NostrEvent): void => {
          if (!byId.has(event.id)) byId.set(event.id, event);
        },
        onEose: oneDone,
        onClosed: oneDone,
      })
        .then((stop: () => void): void => {
          unsubscribes.push(stop);
        })
        .catch((): void => {
          oneDone();
        });
    }

    if (relays.length === 0) finish();
  });
}

export interface ProfileMeta {
  name: string;
  picture: string | null;
  nip05: string | null;
}

function parseProfile(event: NostrEvent): ProfileMeta | null {
  try {
    const meta = JSON.parse(event.content);
    if (!meta || typeof meta !== 'object') return null;
    return {
      name: meta.display_name || meta.name || '',
      picture: typeof meta.picture === 'string' ? meta.picture : null,
      nip05: typeof meta.nip05 === 'string' ? meta.nip05 : null,
    };
  } catch {
    return null;
  }
}

export async function loadHomeTimeline(
  viewer: PubkeyHex,
  onStage: (stage: string) => void,
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();

  onStage('follow list...');
  const follows: PubkeyHex[] = await fetchFollowList(viewer, relays);
  // Seeing your own posts in your own timeline is the web app's behaviour too.
  const authors: PubkeyHex[] = Array.from(new Set([viewer, ...follows])).slice(
    0,
    MAX_AUTHORS,
  );

  onStage(`posts from ${authors.length} people...`);
  const events: NostrEvent[] = await queryRelays(relays, {
    kinds: HOME_KINDS,
    authors,
    limit: POST_LIMIT,
  });

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
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
): Promise<Map<string, ProfileMeta>> {
  const wanted: string[] = Array.from(new Set(pubkeys)).slice(0, MAX_AUTHORS);
  const profiles: Map<string, ProfileMeta> = new Map();
  if (wanted.length === 0) {
    return profiles;
  }

  const profileEvents: NostrEvent[] = await queryRelays(relays, {
    kinds: [0],
    authors: wanted,
  });

  const profileAt: Map<string, number> = new Map();
  for (const event of profileEvents) {
    const previous: number | undefined = profileAt.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) continue;
    const meta: ProfileMeta | null = parseProfile(event);
    if (!meta) continue;
    profiles.set(event.pubkey, meta);
    profileAt.set(event.pubkey, event.created_at);
  }

  return profiles;
}

/**
 * Turns events into rows, with authors attached.
 *
 * Exported because a profile is a timeline. It had its own stripped-down
 * renderer - no avatar, no time, no actions, no pictures - for no reason
 * beyond having been written second.
 */
/**
 * Which of these the author has asked to withdraw.
 *
 * One query for the whole batch rather than one per card. Relays index `e`
 * tags, so this is the filter they are built to answer; the ids are chunked
 * because a filter naming a thousand of them is a filter some relays refuse.
 */
async function fetchDeletedIds(
  relays: string[],
  events: NostrEvent[],
): Promise<Set<string>> {
  const ids: string[] = events.map((event: NostrEvent): string => event.id);
  if (ids.length === 0) {
    return new Set();
  }

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }

  const results = await Promise.allSettled(
    chunks.map((chunk: string[]) =>
      queryRelays(relays, { kinds: [DELETION_KIND], '#e': chunk }),
    ),
  );

  const deletions: NostrEvent[] = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  return collectDeletedIds(events, deletions);
}

export async function decorateEvents(
  relays: string[],
  events: NostrEvent[],
): Promise<Decorated> {
  // Withdrawn posts leave before anything else is done with them, so a
  // deleted post is not fetched a profile for or counted in the stats.
  const deleted: Set<string> = await fetchDeletedIds(relays, events);
  const live: NostrEvent[] = withoutDeleted(events, deleted);

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
  );

  const posts: TimelinePost[] = live
    .slice()
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at)
    .map((event: NostrEvent): TimelinePost => {
      // A repost is a wrapper. What the card shows, and what a like or a
      // reply is addressed to, is the event inside it.
      const reposted: NostrEvent | null = isRepost(event)
        ? readRepost(event).event
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
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();

  onStage(`#${tag}...`);
  const events: NostrEvent[] = await queryRelays(relays, {
    kinds: [1],
    '#t': [tag.toLowerCase()],
    limit: POST_LIMIT,
  });

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
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

export async function loadGlobalTimeline(
  onStage: (stage: string) => void,
): Promise<TimelineResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();
  const sinceHours: number = 6;

  onStage('recent posts...');
  const events: NostrEvent[] = await queryRelays(relays, {
    kinds: [1, 6],
    since: Math.floor(Date.now() / 1000) - sinceHours * 3600,
    limit: POST_LIMIT,
  });

  onStage('profiles...');
  const decorated: Decorated = await decorateEvents(relays, events);

  return {
    posts: decorated.posts,
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

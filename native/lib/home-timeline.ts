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

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { fetchFollowList } from '../../src/common/events-queries';
import { openRelaySubscription } from '../../src/common/relay-socket';
import { getRelays } from '../../src/features/relays/relays';

/** Kinds the home timeline shows. Mirrors `homeKinds` in the web app. */
const HOME_KINDS: number[] = [1, 6];

/** Relays reject enormous `authors` lists, and this is plenty of timeline. */
const MAX_AUTHORS: number = 300;
const POST_LIMIT: number = 400;
const QUERY_TIMEOUT_MS: number = 9000;

export interface TimelinePost {
  id: string;
  pubkey: PubkeyHex;
  createdAt: number;
  content: string;
  kind: number;
  name: string;
  picture: string | null;
  nip05: string | null;
}

export interface TimelineResult {
  posts: TimelinePost[];
  stats: {
    follows: number;
    events: number;
    profiles: number;
    relays: number;
    ms: number;
  };
}

/**
 * Runs one filter across every relay and collects what comes back.
 *
 * Resolves when every relay has sent EOSE or the timeout expires. A relay that
 * never answers costs the timeout and nothing else - the others are not held
 * up waiting for it.
 */
function queryRelays(
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

interface ProfileMeta {
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
  const seenAuthors: string[] = Array.from(
    new Set(events.map((e: NostrEvent): string => e.pubkey)),
  ).slice(0, MAX_AUTHORS);
  const profileEvents: NostrEvent[] = await queryRelays(relays, {
    kinds: [0],
    authors: seenAuthors,
  });

  // A person has one profile; keep the most recently published copy.
  const profiles: Map<string, ProfileMeta> = new Map();
  const profileAt: Map<string, number> = new Map();
  for (const event of profileEvents) {
    const previous: number | undefined = profileAt.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) continue;
    const meta: ProfileMeta | null = parseProfile(event);
    if (!meta) continue;
    profiles.set(event.pubkey, meta);
    profileAt.set(event.pubkey, event.created_at);
  }

  const posts: TimelinePost[] = events
    .slice()
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at)
    .map((event: NostrEvent): TimelinePost => {
      const meta: ProfileMeta | undefined = profiles.get(event.pubkey);
      return {
        id: event.id,
        pubkey: event.pubkey as PubkeyHex,
        createdAt: event.created_at,
        content: event.content,
        kind: event.kind,
        name: meta?.name || `${event.pubkey.slice(0, 8)}...`,
        picture: meta?.picture ?? null,
        nip05: meta?.nip05 ?? null,
      };
    });

  return {
    posts,
    stats: {
      follows: follows.length,
      events: events.length,
      profiles: profiles.size,
      relays: relays.length,
      ms: Date.now() - started,
    },
  };
}

/**
 * One person: their profile and their recent posts.
 *
 * Like the timeline, this sits on the shared relay layer rather than opening
 * its own sockets. The web app's `profile.ts` is 847 lines and builds DOM, so
 * it is not the thing to reuse - but everything underneath it is.
 */

import { openRelaySubscription } from '../../src/common/relay-socket';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';

const QUERY_TIMEOUT_MS: number = 8000;
const POST_LIMIT: number = 100;

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
}

function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve) => {
    const byId: Map<string, NostrEvent> = new Map();
    const stops: Array<() => void> = [];
    let done: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Already gone.
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
          stops.push(stop);
        })
        .catch(oneDone);
    }

    if (relays.length === 0) finish();
  });
}

/**
 * Reads a kind 0. The content is a JSON object its owner wrote, so every
 * field is checked for being a string rather than trusted to be one.
 */
function parseProfile(pubkey: PubkeyHex, event: NostrEvent | null): Profile {
  const fallback: Profile = {
    pubkey,
    name: `${pubkey.slice(0, 8)}...`,
    about: '',
    picture: null,
    banner: null,
    nip05: null,
    website: null,
  };
  if (!event) return fallback;

  try {
    const meta = JSON.parse(event.content);
    if (!meta || typeof meta !== 'object') return fallback;
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value : null;
    return {
      pubkey,
      name: str(meta.display_name) || str(meta.name) || fallback.name,
      about: str(meta.about) ?? '',
      picture: str(meta.picture),
      banner: str(meta.banner),
      nip05: str(meta.nip05),
      website: str(meta.website),
    };
  } catch {
    return fallback;
  }
}

export async function loadProfile(pubkey: PubkeyHex): Promise<ProfileResult> {
  const relays: string[] = getRelays();

  const [metaEvents, postEvents] = await Promise.all([
    queryRelays(relays, { kinds: [0], authors: [pubkey], limit: 1 }),
    queryRelays(relays, { kinds: [1], authors: [pubkey], limit: POST_LIMIT }),
  ]);

  // Relays disagree about which revision is current; the newest wins.
  const newest: NostrEvent | null =
    metaEvents.sort(
      (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
    )[0] ?? null;

  return {
    profile: parseProfile(pubkey, newest),
    posts: postEvents.sort(
      (a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at,
    ),
  };
}

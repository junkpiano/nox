/**
 * One person: their profile and their recent posts.
 *
 * Like the timeline, this sits on the shared relay layer rather than opening
 * its own sockets. The web app's `profile.ts` is 847 lines and builds DOM, so
 * it is not the thing to reuse - but everything underneath it is.
 */

import { queryRelays } from '../../src/common/relay-query';
import { oldestOf, PAGE_LIMIT } from '../../src/common/timeline-paging';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';

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

  const filter: Record<string, unknown> = { kinds: [1], authors: [pubkey] };
  const [metaEvents, postEvents] = await Promise.all([
    queryRelays(relays, { kinds: [0], authors: [pubkey], limit: 1 }),
    queryRelays(relays, { ...filter, limit: POST_LIMIT }),
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
    filter,
    oldestCreatedAt: oldestOf(postEvents),
  };
}

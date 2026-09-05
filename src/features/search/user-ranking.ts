/**
 * Deciding which of several strangers is the person meant.
 *
 * Split out of `user-search.ts` so both front ends can share it. That module
 * builds HTML and reaches the profile cache; this half is arithmetic over
 * strings and moves anywhere - which matters, because importing the other one
 * from React Native would drag in `event-render.ts` and its 2,321 lines of DOM.
 *
 * A NIP-50 relay answers `{kinds:[0], search}` ordered by how recently each
 * profile was edited, which is not an ordering anyone looking for a person
 * wants: searching "jack" returns airport bots, Bluesky bridges and a wall of
 * identically-named strangers, while the well-known Jack is absent because he
 * has not touched his profile in months.
 *
 * So the relay's order is treated as raw material and re-sorted against
 * signals the client already holds - who the viewer follows, whether the name
 * actually matches, whether the profile claims a NIP-05. None costs a request.
 * Follower counts would rank better and need an indexer, which an app with no
 * backend has nowhere to run.
 */

import { nip19 } from 'nostr-tools';
import type { NostrProfile, Npub, PubkeyHex } from '../../../types/nostr';

/**
 * Relays that answer NIP-50 `search` filters.
 *
 * Kept here rather than in the web app's app-state, which is DOM-bound and so
 * unreachable from native. A copy on each side is a list that eventually
 * disagrees with itself.
 */
export const SEARCH_RELAYS: readonly string[] = [
  'wss://search.nos.today/',
  'wss://relay.nostr.band/',
];

export interface UserSearchResult {
  pubkey: PubkeyHex;
  npub: Npub;
  profile: NostrProfile;
  /** `created_at` of the kind 0 this came from; the tie-break within a tier. */
  createdAt: number;
}

/** A display name shares its line with a NIP-05 and has room for a few words. */
export const MAX_NAME_LENGTH: number = 48;
export const MAX_NIP05_LENGTH: number = 64;
export const MAX_ABOUT_LENGTH: number = 140;

const RANK_FOLLOWED: number = 0;
const RANK_EXACT: number = 1;
const RANK_HAS_NIP05: number = 2;
const RANK_OTHER: number = 3;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const WHITESPACE_RUN: RegExp = /[\s\u0000-\u001f\u007f]+/g;

/**
 * Flattens a string its owner chose to one line of bounded length.
 *
 * Unlike a NIP-89 client name, which is stripped of whitespace entirely, a
 * person's name and bio legitimately contain spaces - so runs of whitespace
 * and control characters collapse to a single space instead of vanishing. A
 * newline still cannot survive: these fields each occupy one line of a row.
 *
 * The hyphen in that character class is a range end, not a literal. Writing
 * the control characters raw once turned it into one, which quietly ate the
 * hyphen out of every hyphenated name.
 */
export function oneLine(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.replace(WHITESPACE_RUN, ' ').trim().slice(0, maxLength);
}

/**
 * Reads a pasted identifier as a pubkey.
 *
 * `npub`, `nprofile` and a bare 64-character hex key all name a person
 * directly, so they are answered by fetching that one profile rather than by
 * asking a search relay to match them as text - which it would not.
 */
export function decodePubkeyQuery(query: string): PubkeyHex | null {
  const trimmed: string = query.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase() as PubkeyHex;
  }

  if (!/^(npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(trimmed)) {
    return null;
  }

  try {
    const decoded = nip19.decode(trimmed.toLowerCase());
    if (decoded.type === 'npub') {
      return decoded.data as PubkeyHex;
    }
    if (decoded.type === 'nprofile') {
      return (decoded.data as { pubkey: string }).pubkey as PubkeyHex;
    }
  } catch {
    // Not a name we can read; fall through to a text search.
  }
  return null;
}

export function parseProfileContent(content: string): NostrProfile | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as NostrProfile;
  } catch {
    return null;
  }
}

function isExactNameMatch(profile: NostrProfile, query: string): boolean {
  const needle: string = query.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const candidates: string[] = [
    oneLine(profile.name, MAX_NAME_LENGTH),
    oneLine(profile.display_name, MAX_NAME_LENGTH),
    oneLine(profile.nip05, MAX_NIP05_LENGTH),
  ];
  return candidates.some(
    (candidate: string): boolean => candidate.toLowerCase() === needle,
  );
}

function rankOf(
  result: UserSearchResult,
  query: string,
  followed: ReadonlySet<PubkeyHex>,
): number {
  if (followed.has(result.pubkey)) {
    return RANK_FOLLOWED;
  }
  if (isExactNameMatch(result.profile, query)) {
    return RANK_EXACT;
  }
  if (oneLine(result.profile.nip05, MAX_NIP05_LENGTH)) {
    return RANK_HAS_NIP05;
  }
  return RANK_OTHER;
}

interface RankedResult {
  result: UserSearchResult;
  rank: number;
  hasNip05: boolean;
}

/**
 * Orders results by how likely each is to be the person meant.
 *
 * Within a tier a claimed NIP-05 comes first, and only then edit recency.
 * The tiers alone leave the exact-name tier a wall of identical strangers -
 * a search for "jack" fills it - and inside that wall "edited most recently"
 * is the very signal established as worthless. It is a weak tie-break, since
 * the claim is not checked against the domain here, but claiming one at all
 * is more than a throwaway does.
 *
 * Note none of this can run on a stream: the first profile to arrive is the
 * one edited most recently, which is exactly the ordering being discarded.
 * The whole set is collected before anything is drawn.
 */
export function rankUserResults(
  results: UserSearchResult[],
  query: string,
  followed: ReadonlySet<PubkeyHex>,
): UserSearchResult[] {
  return results
    .map(
      (result: UserSearchResult): RankedResult => ({
        result,
        rank: rankOf(result, query, followed),
        hasNip05: Boolean(oneLine(result.profile.nip05, MAX_NIP05_LENGTH)),
      }),
    )
    .sort((a: RankedResult, b: RankedResult): number => {
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      if (a.hasNip05 !== b.hasNip05) {
        return a.hasNip05 ? -1 : 1;
      }
      return b.result.createdAt - a.result.createdAt;
    })
    .map((entry: RankedResult): UserSearchResult => entry.result);
}

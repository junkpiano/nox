/**
 * Hashtags someone follows: the NIP-51 interests list, kind 10015, one
 * `["t", tag]` per hashtag. Home asks for posts carrying them beside posts
 * from the people followed.
 *
 * Read synchronously when Home builds its question, from a copy kept on the
 * device; the account's copy is fetched and replaces it. Shared with the
 * phone: no DOM here.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { emitAppEvent } from './app-events.js';
import { deleteTimeline } from './db/timelines-store.js';
import { kvGet, kvSet } from './kv.js';
import { publishAndCount } from './publish-event.js';
import {
  NoRelayAnsweredError,
  newestOf,
  queryEveryRelay,
  queryRelaysDetailed,
  supersedes,
} from './relay-query.js';
import { VIEWER_KEY } from './session.js';
import { signWithSession } from './signer.js';

const INTERESTS_KIND: number = 10015;
/** More than this is asked about as the first this many. */
export const MAX_FOLLOWED_HASHTAGS: number = 100;

function localKey(viewer: PubkeyHex): string {
  return `nostr_interests:${viewer}`;
}

/** As NIP-12 indexes a tag: lowercase, no `#`. */
export function normalizeHashtag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

/** The hashtags a list names, each once, in its order. */
export function hashtagsOf(tags: string[][]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== 't' || !tag[1]) continue;
    const name: string = normalizeHashtag(tag[1]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The list's tags with `tag` followed or not. Everything else in it - sets
 * named by `a`, anything another client keeps there - is carried over.
 */
export function nextInterestTags(
  tags: string[][],
  tag: string,
  follow: boolean,
): string[][] {
  const name: string = normalizeHashtag(tag);
  const rest: string[][] = tags
    .filter(
      (entry: string[]): boolean =>
        !(entry[0] === 't' && normalizeHashtag(entry[1] ?? '') === name),
    )
    .map((entry: string[]): string[] => [...entry]);
  return follow ? [...rest, ['t', name]] : rest;
}

/** This device's copy; empty until the account's has been read. */
export function getFollowedHashtags(viewer: PubkeyHex | null): string[] {
  if (!viewer) return [];
  try {
    const parsed: unknown = JSON.parse(kvGet(localKey(viewer)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The whole list as last seen here, so an edit never starts from less. */
type SavedList = Pick<NostrEvent, 'id' | 'tags' | 'content' | 'created_at'>;

function savedListKey(viewer: PubkeyHex): string {
  return `${localKey(viewer)}:list`;
}

function savedList(viewer: PubkeyHex): SavedList | null {
  try {
    const saved = JSON.parse(kvGet(savedListKey(viewer)) ?? 'null');
    return saved &&
      Array.isArray(saved.tags) &&
      typeof saved.content === 'string' &&
      typeof saved.created_at === 'number' &&
      typeof saved.id === 'string'
      ? saved
      : null;
  } catch {
    return null;
  }
}

/** Keeps `list` unless this device already holds a newer one. */
function remember(viewer: PubkeyHex, list: SavedList): void {
  // A refresh that read the old list can finish after an edit saved here.
  const saved: SavedList | null = savedList(viewer);
  if (saved && saved.id !== list.id && !supersedes(list, saved)) return;
  kvSet(localKey(viewer), JSON.stringify(hashtagsOf(list.tags)));
  kvSet(
    savedListKey(viewer),
    JSON.stringify({
      tags: list.tags,
      content: list.content,
      created_at: list.created_at,
      id: list.id,
    }),
  );
}

/** Brings the device's copy up to the account's, and resolves with it. */
export async function refreshFollowedHashtags(
  viewer: PubkeyHex,
  relays: string[],
): Promise<string[]> {
  const list: NostrEvent | null = newestOf(
    await queryEveryRelay(relays, {
      kinds: [INTERESTS_KIND],
      authors: [viewer],
      limit: 1,
    }),
  );
  if (list) {
    const before: string = JSON.stringify(getFollowedHashtags(viewer));
    remember(viewer, list);
    // Changed on another device: the cached Home answered the old question.
    if (JSON.stringify(getFollowedHashtags(viewer)) !== before) {
      await deleteTimeline('home', viewer);
      // Home's question changes too. Home's own refresh lands here, and its
      // reload finds the list unchanged, so this settles after one.
      emitAppEvent('interests-updated');
    }
  }
  return getFollowedHashtags(viewer);
}

/**
 * One change to a person's list at a time: two started together would each
 * read the same list, and the second would quietly undo the first.
 */
const pending: Map<PubkeyHex, Promise<unknown>> = new Map();

/** Follows or unfollows `tag`, and publishes the list. */
export function setHashtagFollowed(
  viewer: PubkeyHex,
  relays: string[],
  tag: string,
  follow: boolean,
): Promise<void> {
  const before: Promise<unknown> = pending.get(viewer) ?? Promise.resolve();
  const run: Promise<void> = before
    .catch((): void => {})
    .then(() => setNow(viewer, relays, tag, follow));
  pending.set(viewer, run);
  // Both ways: a failed edit is the caller's to report, not unhandled here.
  const forget = (): void => {
    if (pending.get(viewer) === run) pending.delete(viewer);
  };
  run.then(forget, forget);
  return run;
}

async function setNow(
  viewer: PubkeyHex,
  relays: string[],
  tag: string,
  follow: boolean,
): Promise<void> {
  const result = await queryRelaysDetailed(
    relays,
    { kinds: [INTERESTS_KIND], authors: [viewer], limit: 1 },
    undefined,
    { everyRelay: true },
  );
  // Every relay is waited for; more than half of them must have answered.
  // The list is replaced whole, so a silent relay might hold a newer copy -
  // but a change that reached only one relay is rare, and requiring all of
  // them let a single relay that was down for days make the list uneditable.
  if (result.answered * 2 <= new Set(relays).size) {
    throw new NoRelayAnsweredError(relays);
  }
  const remote: NostrEvent | null = newestOf(result.events);
  const local: SavedList | null = savedList(viewer);
  // Relays that lack the list, or hold an older one - after switching
  // relays, say - must not stand in for the newer one this device saved.
  const list: SavedList | null =
    local && (!remote || supersedes(local, remote)) ? local : remote;
  const tags: string[][] = nextInterestTags(list?.tags ?? [], tag, follow);
  // Another account signing would replace that account's list with this one.
  if (kvGet(VIEWER_KEY) !== viewer) {
    throw new Error('The account changed while the list was read.');
  }
  const signed: NostrEvent = await signWithSession({
    kind: INTERESTS_KIND,
    // Later than the copy it replaces, even on a clock that runs behind.
    created_at: Math.max(
      Math.floor(Date.now() / 1000),
      (list?.created_at ?? 0) + 1,
    ),
    tags,
    content: list?.content ?? '',
  });
  if (signed.pubkey !== viewer) {
    throw new Error('The list was signed by another account.');
  }
  if ((await publishAndCount(signed, relays)) === 0) {
    throw new Error('No relay accepted the list.');
  }
  remember(viewer, signed);
  // The cached Home was answered to the old question: posts a dropped tag
  // let in would otherwise come back with it.
  await deleteTimeline('home', viewer);
  emitAppEvent('interests-updated');
}

/** Home's question: posts from `authors`, or carrying a followed hashtag. */
export function homeFilters(
  kinds: number[],
  authors: string[],
  hashtags: string[],
): Array<Record<string, unknown>> {
  const filters: Array<Record<string, unknown>> = [{ kinds, authors }];
  if (hashtags.length > 0) {
    filters.push({
      kinds: [1],
      '#t': hashtags.slice(0, MAX_FOLLOWED_HASHTAGS),
    });
  }
  return filters;
}

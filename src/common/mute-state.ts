/**
 * In-memory view of the viewer's mute list.
 *
 * Every render path consults this while building cards, so the lookup has to be
 * synchronous. The set is filled once at startup from the cache, refreshed from
 * relays in the background, and updated in place when the user mutes someone.
 */

import type { PubkeyHex } from '../../types/nostr';
import {
  EMPTY_MUTE_ENTRIES,
  type MuteEntries,
  matchesMutedWord,
} from '../features/moderation/mute-entries.js';
import { emitAppEvent } from './app-events.js';
import { getMetadata, setMetadata } from './db/index.js';

/**
 * Cached copy of the decrypted list, so a cold start filters correctly.
 *
 * v2 because v1 held only the pubkeys. An old entry still loads - the words
 * and the tags this app does not act on are simply absent from it, and the
 * first refresh from the relays puts them back.
 */
const CACHE_KEY: string = 'mute_list_v2';
const LEGACY_CACHE_KEY: string = 'mute_list_v1';

interface CachedMuteList {
  pubkeys: PubkeyHex[];
  words?: string[];
  otherTags?: string[][];
  createdAt: number;
}

let entries: MuteEntries = EMPTY_MUTE_ENTRIES;
let mutedPubkeys: Set<PubkeyHex> = new Set();
let listCreatedAt: number = 0;

function persist(): void {
  void setMetadata(CACHE_KEY, {
    pubkeys: entries.pubkeys,
    words: entries.words,
    otherTags: entries.otherTags,
    createdAt: listCreatedAt,
  } satisfies CachedMuteList);
}

/** The whole list, for anything that has to publish it back. */
export function getMuteEntries(): MuteEntries {
  return entries;
}

export function getMutedWords(): string[] {
  return entries.words;
}

/** Notifies views so an open timeline can drop the muted author immediately. */
function announceChange(): void {
  emitAppEvent('mute-list-updated');
}

/**
 * Whether an author is muted.
 *
 * Synchronous by design: it is called per event while rendering.
 */
export function isMuted(pubkey: PubkeyHex | string): boolean {
  return mutedPubkeys.has(pubkey as PubkeyHex);
}

/**
 * Whether a post's own text is muted by one of the words.
 *
 * Only the text is examined. A post whose image is the objectionable part
 * passes this, which is the honest limit of a word filter and the reason it is
 * offered alongside NIP-36 rather than instead of it.
 */
export function isMutedContent(content: string): boolean {
  return matchesMutedWord(content, entries.words);
}

/** Drops muted authors and muted words, for list-shaped render paths. */
export function filterMutedEvents<
  T extends { pubkey: string; content?: string },
>(events: T[]): T[] {
  if (mutedPubkeys.size === 0 && entries.words.length === 0) {
    return events;
  }
  return events.filter(
    (event: T): boolean =>
      !isMuted(event.pubkey) && !isMutedContent(event.content ?? ''),
  );
}

export function getMutedPubkeys(): PubkeyHex[] {
  return Array.from(mutedPubkeys);
}

export function getMuteListCreatedAt(): number {
  return listCreatedAt;
}

/**
 * Replaces the whole list, ignoring anything older than what is loaded.
 *
 * kind:10000 is replaceable, so relays may answer with an older revision after
 * a local change has already been applied.
 */
export function setMuteList(next: MuteEntries, createdAt: number): boolean {
  if (createdAt < listCreatedAt) {
    return false;
  }

  // The background refresh usually returns what is already loaded. Announcing
  // that would re-run the route and reload the timeline on every startup.
  const changed: boolean = JSON.stringify(next) !== JSON.stringify(entries);

  entries = next;
  mutedPubkeys = new Set(next.pubkeys);
  listCreatedAt = createdAt;
  persist();

  if (changed) {
    announceChange();
  }
  return true;
}

/**
 * Applies a mute locally, ahead of the relay round-trip.
 *
 * Returns the list to publish, or null when the author was already muted.
 */
export function addMutedLocally(pubkey: PubkeyHex): MuteEntries | null {
  if (mutedPubkeys.has(pubkey)) {
    return null;
  }
  mutedPubkeys.add(pubkey);
  // Spread rather than push: the rest of the list travels with the change, so
  // whoever publishes this cannot accidentally send the people alone.
  entries = { ...entries, pubkeys: Array.from(mutedPubkeys) };
  persist();
  announceChange();
  return entries;
}

export function removeMutedLocally(pubkey: PubkeyHex): MuteEntries | null {
  if (!mutedPubkeys.delete(pubkey)) {
    return null;
  }
  entries = { ...entries, pubkeys: Array.from(mutedPubkeys) };
  persist();
  announceChange();
  return entries;
}

/**
 * Applies a word change locally. Returns null when nothing changed.
 *
 * Words arrive from a text field, so they are trimmed and lowercased here
 * rather than trusting the caller: the matcher compares lowercased text, and a
 * stray capital would silently mute nothing.
 */
export function setMutedWordsLocally(words: string[]): MuteEntries | null {
  const next: string[] = Array.from(
    new Set(
      words
        .map((word: string): string => word.trim().toLowerCase())
        .filter((word: string): boolean => word.length > 0),
    ),
  );
  if (JSON.stringify(next) === JSON.stringify(entries.words)) {
    return null;
  }
  entries = { ...entries, words: next };
  // Persisted before the publish, not after it. A relay that refuses the write
  // must not be able to un-mute something on the next launch.
  persist();
  announceChange();
  return entries;
}

/** Restores the cached list. Cheap enough to await during boot. */
export async function loadCachedMuteList(): Promise<void> {
  try {
    const cached: CachedMuteList | null =
      (await getMetadata<CachedMuteList>(CACHE_KEY)) ??
      (await getMetadata<CachedMuteList>(LEGACY_CACHE_KEY));
    if (cached && Array.isArray(cached.pubkeys)) {
      entries = {
        pubkeys: cached.pubkeys,
        words: cached.words ?? [],
        otherTags: cached.otherTags ?? [],
      };
      mutedPubkeys = new Set(entries.pubkeys);
      listCreatedAt = cached.createdAt ?? 0;
    }
  } catch (error: unknown) {
    console.warn('[mute] Failed to load cached mute list:', error);
  }
}

/** Clears state on logout so the next account does not inherit it. */
export function clearMuteList(): void {
  entries = EMPTY_MUTE_ENTRIES;
  mutedPubkeys = new Set();
  listCreatedAt = 0;
  persist();
  announceChange();
}

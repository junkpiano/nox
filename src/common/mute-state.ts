/**
 * In-memory view of the viewer's mute list.
 *
 * Every render path consults this while building cards, so the lookup has to be
 * synchronous. The set is filled once at startup from the cache, refreshed from
 * relays in the background, and updated in place when the user mutes someone.
 */

import type { PubkeyHex } from '../../types/nostr';
import { emitAppEvent } from './app-events.js';
import { getMetadata, setMetadata } from './db/index.js';

/** Cached copy of the decrypted list, so a cold start filters correctly. */
const CACHE_KEY: string = 'mute_list_v1';

interface CachedMuteList {
  pubkeys: PubkeyHex[];
  createdAt: number;
}

let mutedPubkeys: Set<PubkeyHex> = new Set();
let listCreatedAt: number = 0;

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

/** Drops events from muted authors, for list-shaped render paths. */
export function filterMutedEvents<T extends { pubkey: string }>(
  events: T[],
): T[] {
  if (mutedPubkeys.size === 0) {
    return events;
  }
  return events.filter((event: T): boolean => !isMuted(event.pubkey));
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
export function setMuteList(pubkeys: PubkeyHex[], createdAt: number): boolean {
  if (createdAt < listCreatedAt) {
    return false;
  }

  const next: Set<PubkeyHex> = new Set(pubkeys);
  // The background refresh usually returns what is already loaded. Announcing
  // that would re-run the route and reload the timeline on every startup.
  const changed: boolean =
    next.size !== mutedPubkeys.size ||
    Array.from(next).some(
      (pubkey: PubkeyHex): boolean => !mutedPubkeys.has(pubkey),
    );

  mutedPubkeys = next;
  listCreatedAt = createdAt;

  void setMetadata(CACHE_KEY, {
    pubkeys: Array.from(mutedPubkeys),
    createdAt,
  } satisfies CachedMuteList);

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
export function addMutedLocally(pubkey: PubkeyHex): PubkeyHex[] | null {
  if (mutedPubkeys.has(pubkey)) {
    return null;
  }
  mutedPubkeys.add(pubkey);
  announceChange();
  return Array.from(mutedPubkeys);
}

export function removeMutedLocally(pubkey: PubkeyHex): PubkeyHex[] | null {
  if (!mutedPubkeys.delete(pubkey)) {
    return null;
  }
  announceChange();
  return Array.from(mutedPubkeys);
}

/** Restores the cached list. Cheap enough to await during boot. */
export async function loadCachedMuteList(): Promise<void> {
  try {
    const cached = await getMetadata<CachedMuteList>(CACHE_KEY);
    if (cached && Array.isArray(cached.pubkeys)) {
      mutedPubkeys = new Set(cached.pubkeys);
      listCreatedAt = cached.createdAt ?? 0;
    }
  } catch (error: unknown) {
    console.warn('[mute] Failed to load cached mute list:', error);
  }
}

/** Clears state on logout so the next account does not inherit it. */
export function clearMuteList(): void {
  mutedPubkeys = new Set();
  listCreatedAt = 0;
  void setMetadata(CACHE_KEY, {
    pubkeys: [],
    createdAt: 0,
  } satisfies CachedMuteList);
  announceChange();
}

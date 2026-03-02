import type { NostrProfile, PubkeyHex } from '../../../types/nostr';
import { isTimelineCacheEnabled } from '../../common/cache-settings.js';

interface ProfileCacheStore {
  order: PubkeyHex[];
  items: Record<PubkeyHex, NostrProfile>;
}

const PROFILE_CACHE_KEY: string = 'nostr_profile_cache_v1';
const PROFILE_CACHE_LIMIT: number = 1000;

function readStore(): ProfileCacheStore {
  try {
    const raw: string | null = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) {
      return { order: [], items: {} };
    }

    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as ProfileCacheStore).order) ||
      typeof (parsed as ProfileCacheStore).items !== 'object'
    ) {
      return { order: [], items: {} };
    }

    return parsed as ProfileCacheStore;
  } catch {
    return { order: [], items: {} };
  }
}

function writeStore(store: ProfileCacheStore): void {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(store));
  } catch (error: unknown) {
    console.warn('Failed to persist profile cache:', error);
  }
}

export function getCachedProfile(pubkey: PubkeyHex): NostrProfile | null {
  if (!isTimelineCacheEnabled()) {
    return null;
  }

  const store: ProfileCacheStore = readStore();
  const profile: NostrProfile | undefined = store.items[pubkey];
  if (!profile) {
    return null;
  }

  // LRU bump on read.
  store.order = store.order.filter((key: PubkeyHex): boolean => key !== pubkey);
  store.order.push(pubkey);
  writeStore(store);
  return profile;
}

export function setCachedProfile(
  pubkey: PubkeyHex,
  profile: NostrProfile,
): void {
  if (!isTimelineCacheEnabled()) {
    return;
  }

  const store: ProfileCacheStore = readStore();

  store.items[pubkey] = profile;
  store.order = store.order.filter((key: PubkeyHex): boolean => key !== pubkey);
  store.order.push(pubkey);

  while (store.order.length > PROFILE_CACHE_LIMIT) {
    const oldestPubkey: PubkeyHex | undefined = store.order.shift();
    if (!oldestPubkey) {
      break;
    }
    delete store.items[oldestPubkey];
  }

  writeStore(store);
}

export function getProfileCacheStats(): { count: number; bytes: number } {
  try {
    const raw: string | null = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) {
      return { count: 0, bytes: 0 };
    }
    const encoder: TextEncoder | null =
      typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const bytes: number = encoder ? encoder.encode(raw).length : raw.length;
    const store: ProfileCacheStore = readStore();
    return { count: store.order.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export function clearProfileCache(): void {
  try {
    localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    // ignore
  }
}

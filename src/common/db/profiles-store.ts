import type { NostrProfile, PubkeyHex } from '../../../types/nostr.js';
import { isTimelineCacheEnabled } from '../cache-settings.js';
import {
  createTransaction,
  isIndexedDBAvailable,
  requestToPromise,
  transactionToPromise,
} from './indexeddb.js';
import { type CachedProfile, LIMITS, STORE_NAMES, TTL } from './types.js';

/**
 * Stores a single profile in the cache
 */
export async function storeProfile(
  pubkey: PubkeyHex,
  profile: NostrProfile,
): Promise<void> {
  if (!isIndexedDBAvailable() || !isTimelineCacheEnabled()) return;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    const now = Date.now();

    const cachedProfile: CachedProfile = {
      pubkey,
      profile,
      storedAt: now,
      accessedAt: now,
    };

    store.put(cachedProfile);
    await transactionToPromise(tx);
  } catch (error) {
    console.error('[ProfilesStore] Failed to store profile:', error);
  }
}

/**
 * Stores multiple profiles in a batch
 */
export async function storeProfiles(
  profiles: Array<{ pubkey: PubkeyHex; profile: NostrProfile }>,
): Promise<void> {
  if (
    !isIndexedDBAvailable() ||
    !isTimelineCacheEnabled() ||
    profiles.length === 0
  )
    return;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    const now = Date.now();

    for (const { pubkey, profile } of profiles) {
      const cachedProfile: CachedProfile = {
        pubkey,
        profile,
        storedAt: now,
        accessedAt: now,
      };
      store.put(cachedProfile);
    }

    await transactionToPromise(tx);
    console.log(`[ProfilesStore] Stored ${profiles.length} profiles`);
  } catch (error) {
    console.error('[ProfilesStore] Failed to store profiles:', error);
  }
}

/**
 * Retrieves a single profile by pubkey
 */
export async function getProfile(
  pubkey: PubkeyHex,
): Promise<NostrProfile | null> {
  if (!isIndexedDBAvailable()) return null;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);

    const record = await requestToPromise<CachedProfile | undefined>(
      store.get(pubkey),
    );

    if (!record) return null;

    const now = Date.now();

    // Check if expired
    if (now - record.storedAt > TTL.PROFILE) {
      store.delete(pubkey);
      return null;
    }

    // Update access time for LRU
    record.accessedAt = now;
    store.put(record);

    return record.profile;
  } catch (error) {
    console.error('[ProfilesStore] Failed to get profile:', error);
    return null;
  }
}

/**
 * Retrieves multiple profiles by pubkeys
 */
export async function getProfiles(
  pubkeys: PubkeyHex[],
): Promise<Map<PubkeyHex, NostrProfile>> {
  if (!isIndexedDBAvailable() || pubkeys.length === 0) return new Map();

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    const now = Date.now();
    const profiles = new Map<PubkeyHex, NostrProfile>();

    for (const pubkey of pubkeys) {
      const record = await requestToPromise<CachedProfile | undefined>(
        store.get(pubkey),
      );

      if (!record) continue;

      // Check if expired
      if (now - record.storedAt > TTL.PROFILE) {
        store.delete(pubkey);
        continue;
      }

      // Update access time for LRU
      record.accessedAt = now;
      store.put(record);

      profiles.set(pubkey, record.profile);
    }

    return profiles;
  } catch (error) {
    console.error('[ProfilesStore] Failed to get profiles:', error);
    return new Map();
  }
}

/**
 * Checks if a profile needs refresh (older than 24 hours)
 */
export async function profileNeedsRefresh(pubkey: PubkeyHex): Promise<boolean> {
  if (!isIndexedDBAvailable()) return true;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readonly');
    const store = tx.objectStore(STORE_NAMES.PROFILES);

    const record = await requestToPromise<CachedProfile | undefined>(
      store.get(pubkey),
    );

    if (!record) return true;

    const now = Date.now();
    return now - record.storedAt > TTL.PROFILE_REFRESH;
  } catch (error) {
    console.error('[ProfilesStore] Failed to check profile refresh:', error);
    return true;
  }
}

/**
 * Counts total profiles in the store
 */
export async function countProfiles(): Promise<number> {
  if (!isIndexedDBAvailable()) return 0;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readonly');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    return await requestToPromise<number>(store.count());
  } catch (error) {
    console.error('[ProfilesStore] Failed to count profiles:', error);
    return 0;
  }
}

/**
 * Prunes profiles using LRU eviction when limit is exceeded
 */
export async function pruneProfiles(): Promise<number> {
  if (!isIndexedDBAvailable()) return 0;

  try {
    const count = await countProfiles();
    if (count <= LIMITS.PROFILES) {
      return 0; // No pruning needed
    }

    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    const index = store.index('accessedAt');

    const toDelete = count - LIMITS.PROFILES;
    let deleted = 0;

    return new Promise<number>((resolve, reject) => {
      const cursorRequest = index.openCursor(); // Oldest accessed first

      cursorRequest.onsuccess = (): void => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= toDelete) {
          console.log(`[ProfilesStore] Pruned ${deleted} profiles (LRU)`);
          resolve(deleted);
          return;
        }

        cursor.delete();
        deleted++;
        cursor.continue();
      };

      cursorRequest.onerror = (): void => reject(cursorRequest.error);
    });
  } catch (error) {
    console.error('[ProfilesStore] Failed to prune profiles:', error);
    return 0;
  }
}

/**
 * Clears all profiles from the store
 */
export async function clearProfiles(): Promise<void> {
  if (!isIndexedDBAvailable()) return;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);
    await requestToPromise(store.clear());
    console.log('[ProfilesStore] Cleared all profiles');
  } catch (error) {
    console.error('[ProfilesStore] Failed to clear profiles:', error);
  }
}

/**
 * Deletes specific profiles by pubkeys
 */
export async function deleteProfiles(pubkeys: PubkeyHex[]): Promise<void> {
  if (!isIndexedDBAvailable() || pubkeys.length === 0) return;

  try {
    const tx = await createTransaction(STORE_NAMES.PROFILES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.PROFILES);

    for (const pubkey of pubkeys) {
      store.delete(pubkey);
    }

    await transactionToPromise(tx);
    console.log(`[ProfilesStore] Deleted ${pubkeys.length} profiles`);
  } catch (error) {
    console.error('[ProfilesStore] Failed to delete profiles:', error);
  }
}

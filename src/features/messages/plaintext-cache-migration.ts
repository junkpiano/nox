/**
 * One-time removal of the plaintext message cache.
 *
 * Encrypting the cache changes what the app writes; it does not change what is
 * already on disk. IndexedDB is LevelDB underneath, and LevelDB never
 * overwrites in place - putting an encrypted value under a key appends a new
 * record and leaves the old plaintext one in whatever sorted table it happens
 * to live in. Measured on a device: after the upgrade the plaintext sat in a
 * level-2 table, and ordinary use produced nowhere near enough writes to
 * compact it away.
 *
 * So the value is replaced *and* the database is rebuilt. Deleting an IndexedDB
 * database removes its files outright, which is the only move available at this
 * layer that reliably takes the old bytes with it.
 *
 * Only installs that actually hold a plaintext cache pay anything. Events,
 * profiles and timelines are refetchable by design and come back on demand.
 * Metadata is small and is carried across, so the mute list still filters the
 * first render rather than letting muted authors flash past once.
 */

import {
  deleteDatabase,
  deleteMetadata,
  getAllMetadata,
  getMetadata,
  setMetadata,
} from '../../common/db/index.js';
import type { Metadata } from '../../common/db/types.js';
import {
  adoptMessages,
  flushMessageCache,
  type StoredMessage,
} from './messages-store.js';

const CACHE_KEY: string = 'dm_messages_v1';

/**
 * Set when the value was encrypted but the rebuild did not happen.
 *
 * Without it a single blocked deletion would leave the old plaintext on disk
 * permanently: the cache is no longer an array by then, so nothing would ever
 * detect that there is still something to clean up.
 */
const REBUILD_PENDING_KEY: string = 'dm_cache_rebuild_pending';

/** A service worker or another tab can hold the database open. */
const DELETE_TIMEOUT_MS: number = 5000;

/**
 * Resolves false rather than hanging.
 *
 * `deleteDatabase` reports a blocked deletion by logging and never settling, so
 * without a bound this would stall boot behind whatever is holding the handle.
 */
async function deleteWithTimeout(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut: Promise<boolean> = new Promise((resolve): void => {
    timer = setTimeout((): void => resolve(false), DELETE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      deleteDatabase().then(
        (): boolean => true,
        (): boolean => false,
      ),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Must run before anything else touches the database.
 *
 * A read in flight when the rebuild lands is a read that never returns.
 */
export async function migrateLegacyMessageCache(): Promise<void> {
  let stored: unknown;
  try {
    stored = await getMetadata(CACHE_KEY);
  } catch {
    return;
  }

  // An array is a cache written before encryption. Anything else is either
  // absent or already encrypted - in which case there is only work to do if a
  // previous run replaced the value but could not finish the rebuild.
  const legacy: StoredMessage[] | null = Array.isArray(stored)
    ? (stored as StoredMessage[])
    : null;
  const pending: boolean =
    legacy === null &&
    (await getMetadata<boolean>(REBUILD_PENDING_KEY)) === true;

  if (legacy === null && !pending) {
    return;
  }

  if (legacy) {
    // Encrypt first. Whatever happens to the rebuild below, the value under
    // this key is never plaintext again.
    adoptMessages(legacy);
    await flushMessageCache();
    await setMetadata(REBUILD_PENDING_KEY, true);
  }

  // Read after the encrypted write, so the snapshot carries ciphertext rather
  // than the blob this whole exercise exists to destroy.
  const carried: Metadata[] = (await getAllMetadata()).filter(
    (entry: Metadata): boolean => entry.key !== REBUILD_PENDING_KEY,
  );

  if (!(await deleteWithTimeout())) {
    // The cache is encrypted either way; the old bytes stay until LevelDB
    // compacts, and the flag brings us back here on the next launch. Worth
    // saying out loud rather than reporting a clean upgrade.
    console.warn(
      '[dm] Could not rebuild the database - plaintext may remain on disk until the next launch.',
    );
    return;
  }

  // The first write recreates the database.
  for (const entry of carried) {
    await setMetadata(entry.key, entry.value);
  }
  await deleteMetadata(REBUILD_PENDING_KEY);
}

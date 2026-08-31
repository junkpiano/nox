/**
 * The native side of the storage seams.
 *
 * `expo-sqlite/kv-store` is a synchronous key/value API over SQLite, which is
 * the one thing that makes this possible: the shared code reads settings
 * synchronously from inside functions that cannot await, so an async store
 * would have meant rewriting every caller. This is a drop-in for the shape
 * `localStorage` already had.
 *
 * Secrets do not go here. The Nostr private key and the NWC connection secret
 * live in the platform credential store, as they do on the web build - see
 * `secrets.ts`.
 */

import Storage from 'expo-sqlite/kv-store';

import { setKvStore } from '../../src/common/kv';

/**
 * Installs the native store. Called once, before anything reads a setting.
 *
 * Anything written before this point was held in memory by the shared module
 * and is replayed in, so a value saved during start-up is not lost.
 */
export function installNativeStorage(): void {
  setKvStore({
    get(key: string): string | null {
      try {
        return Storage.getItemSync(key);
      } catch (error: unknown) {
        console.warn(`[storage] read ${key} failed`, error);
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        Storage.setItemSync(key, value);
      } catch (error: unknown) {
        // Same judgement as the web build: losing a preference is not worth
        // interrupting anyone over.
        console.warn(`[storage] write ${key} failed`, error);
      }
    },
    remove(key: string): void {
      try {
        Storage.removeItemSync(key);
      } catch (error: unknown) {
        console.warn(`[storage] remove ${key} failed`, error);
      }
    },
  });
}

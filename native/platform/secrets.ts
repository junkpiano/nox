/**
 * Secrets, in the Android Keystore.
 *
 * Three things pass through here: the Nostr private key, the DM cache key and
 * the NWC connection secret. `expo-secure-store` puts them behind the platform
 * credential store, which is the same guarantee the Tauri build gets from the
 * keyring - and the reason CLAUDE.md says neither key may live in
 * `localStorage`.
 *
 * Expo is here in part to absorb one specific failure: the Tauri Android
 * keyring *panics* rather than erroring when `ndk_context` is missing, which
 * is why `secret_store.rs` defers construction and wraps it in `catch_unwind`
 * and why that build must never set `panic = "abort"`. None of that applies
 * here.
 *
 * **Nothing falls back to plain storage.** The web build drops to
 * `localStorage` when its keyring misbehaves, on the grounds that a broken
 * keyring must not lock someone out of their own account. The same move here
 * would write a private key into the app's ordinary SQLite file - a real
 * downgrade wearing the clothes of resilience. A failure that can be seen is
 * better than a key that is quietly less protected than the person thinks.
 */

import * as SecureStore from 'expo-secure-store';

import { setSecretBackend } from '../../src/common/secret-store';

/**
 * SecureStore keys allow only letters, numbers, `.`, `-` and `_`, and the
 * callers pass names like `nostr_private_key`. Anything outside that set is
 * replaced rather than passed through, so a new caller cannot fail silently.
 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

export function installNativeSecrets(): void {
  setSecretBackend({
    async get(key: string): Promise<Uint8Array | null> {
      const stored: string | null = await SecureStore.getItemAsync(
        safeKey(key),
      );
      // The value is never logged, here or anywhere: this is the one string in
      // the app that must not appear in a log the viewer might share.
      return stored ? hexToBytes(stored) : null;
    },

    async set(key: string, value: Uint8Array): Promise<void> {
      await SecureStore.setItemAsync(safeKey(key), bytesToHex(value), {
        // Available whenever the device is unlocked, and not moved to a new
        // device by a backup - a key restored onto someone else's phone is a
        // key that has left its owner.
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    },

    async delete(key: string): Promise<void> {
      await SecureStore.deleteItemAsync(safeKey(key));
    },
  });
}

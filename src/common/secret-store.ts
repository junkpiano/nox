/**
 * Persistent storage for the Nostr private key.
 *
 * The native shell keeps the key in the platform credential store, which
 * encrypts at rest (Android Keystore, Keychain, Credential Manager, keyutils).
 * A browser has no equivalent, so the web build keeps its existing
 * `localStorage` behaviour unchanged.
 */

import { isNativeRuntime } from './native-http.js';

function hexToBytes(hex: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Reads the web fallback slot. Also the source for one-time migration. */
function readLocalStorage(key: string): Uint8Array | null {
  try {
    const stored: string | null = localStorage.getItem(key);
    return stored ? hexToBytes(stored) : null;
  } catch (error: unknown) {
    console.warn('[secret-store] Failed to read local storage:', error);
    return null;
  }
}

function writeLocalStorage(key: string, value: Uint8Array): void {
  try {
    localStorage.setItem(key, bytesToHex(value));
  } catch (error: unknown) {
    console.warn('[secret-store] Failed to write local storage:', error);
  }
}

function clearLocalStorage(key: string): void {
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch (error: unknown) {
    console.warn('[secret-store] Failed to clear local storage:', error);
  }
}

/**
 * Reads the stored secret.
 *
 * On native, a value left in `localStorage` by an earlier build is migrated
 * into the credential store and the plaintext copy removed, so upgrading users
 * stop carrying a readable key on disk.
 */
export async function readSecret(key: string): Promise<Uint8Array | null> {
  if (!isNativeRuntime()) {
    return readLocalStorage(key);
  }

  try {
    const stored = await invokeCommand<number[] | null>('secret_get', { key });
    if (stored !== null) {
      return new Uint8Array(stored);
    }

    const legacy: Uint8Array | null = readLocalStorage(key);
    if (legacy) {
      await invokeCommand('secret_set', { key, value: Array.from(legacy) });
      clearLocalStorage(key);
      console.info('[secret-store] Migrated key into the credential store');
      return legacy;
    }

    return null;
  } catch (error: unknown) {
    // A broken keyring must not lock the user out of their own account.
    console.warn(
      '[secret-store] Credential store unavailable, falling back:',
      error,
    );
    return readLocalStorage(key);
  }
}

export async function writeSecret(
  key: string,
  value: Uint8Array,
): Promise<void> {
  if (!isNativeRuntime()) {
    writeLocalStorage(key, value);
    return;
  }

  try {
    await invokeCommand('secret_set', { key, value: Array.from(value) });
    // Drop any plaintext copy from a previous build.
    clearLocalStorage(key);
  } catch (error: unknown) {
    console.warn(
      '[secret-store] Credential store write failed, falling back:',
      error,
    );
    writeLocalStorage(key, value);
  }
}

/** Clears both stores, so logout cannot leave a copy behind either side. */
export async function deleteSecret(key: string): Promise<void> {
  clearLocalStorage(key);

  if (!isNativeRuntime()) {
    return;
  }

  try {
    await invokeCommand('secret_delete', { key });
  } catch (error: unknown) {
    console.warn('[secret-store] Credential store delete failed:', error);
  }
}

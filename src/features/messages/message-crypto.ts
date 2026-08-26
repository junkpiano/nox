/**
 * Encryption at rest for the decrypted message cache.
 *
 * A gift wrap is unreadable on the wire, but unwrapping one produces plaintext
 * that has to live somewhere for a thread to open without decrypting every
 * message again. Left as it was, that put the contents of every private
 * conversation into a file that a device backup, a rooted phone or a copied
 * browser profile can read - undoing on disk what NIP-44 did on the wire.
 *
 * The key is generated here, never leaves this device, and is not derived from
 * anything the user types or the account owns. There is nothing to export and
 * nothing to sync. That is deliberate rather than incidental: this client does
 * not carry private messages anywhere, and an exportable key is the first half
 * of a feature that would.
 *
 * Where the key lives differs by platform, because the best store available
 * differs:
 *   - native: 32 random bytes in the platform credential store, which on
 *     Android is hardware-backed.
 *   - web: a non-extractable CryptoKey in IndexedDB. Script can use it but
 *     cannot read it back out, so a dump of the database yields ciphertext and
 *     an unusable handle rather than a key.
 */

import { getMetadata, setMetadata } from '../../common/db/index.js';
import { isNativeRuntime } from '../../common/native-http.js';
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from '../../common/secret-store.js';

/** Native: entry name in the platform credential store. */
const KEY_SECRET_NAME: string = 'dm_cache_key';
/** Web: where the non-extractable CryptoKey is kept. */
const KEY_METADATA_KEY: string = 'dm_cache_key_v1';

const KEY_BYTES: number = 32;
/** 96 bits, the size AES-GCM is specified around. */
const IV_BYTES: number = 12;

export interface EncryptedPayload {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

let keyPromise: Promise<CryptoKey | null> | null = null;

/**
 * Absent outside a secure context.
 *
 * Callers read a missing SubtleCrypto as "do not persist", never as a reason to
 * fall back to plaintext.
 */
function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

async function loadNativeKey(api: SubtleCrypto): Promise<CryptoKey> {
  let raw: Uint8Array | null = await readSecret(KEY_SECRET_NAME);
  if (!raw || raw.length !== KEY_BYTES) {
    raw = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    await writeSecret(KEY_SECRET_NAME, raw);
  }
  return api.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function loadWebKey(api: SubtleCrypto): Promise<CryptoKey> {
  const stored: unknown = await getMetadata(KEY_METADATA_KEY);
  if (stored instanceof CryptoKey) {
    return stored;
  }

  const key: CryptoKey = await api.generateKey(
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    // Not extractable: the point is that this cannot be read back out.
    false,
    ['encrypt', 'decrypt'],
  );
  await setMetadata(KEY_METADATA_KEY, key);
  return key;
}

/** Resolved once and reused; generating a second key would orphan the first. */
function getKey(): Promise<CryptoKey | null> {
  if (!keyPromise) {
    keyPromise = (async (): Promise<CryptoKey | null> => {
      const api: SubtleCrypto | null = subtle();
      if (!api) {
        return null;
      }
      try {
        return isNativeRuntime()
          ? await loadNativeKey(api)
          : await loadWebKey(api);
      } catch (error: unknown) {
        console.warn('[dm] Cache key unavailable:', error);
        return null;
      }
    })();
  }
  return keyPromise;
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<EncryptedPayload>;
  return (
    candidate.v === 1 &&
    candidate.iv instanceof Uint8Array &&
    candidate.ct instanceof ArrayBuffer
  );
}

/** Returns null when no key is available, which means "do not write". */
export async function encryptJson(
  value: unknown,
): Promise<EncryptedPayload | null> {
  const api: SubtleCrypto | null = subtle();
  const key: CryptoKey | null = await getKey();
  if (!api || !key) {
    return null;
  }

  try {
    // A fresh IV per write. AES-GCM fails catastrophically on IV reuse, and
    // this rewrites the whole blob on every message.
    const iv: Uint8Array<ArrayBuffer> = globalThis.crypto.getRandomValues(
      new Uint8Array(IV_BYTES),
    );
    const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
      JSON.stringify(value),
    );
    const ct: ArrayBuffer = await api.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );
    return { v: 1, iv, ct };
  } catch (error: unknown) {
    console.warn('[dm] Failed to encrypt cache:', error);
    return null;
  }
}

/**
 * Returns null when the payload cannot be read.
 *
 * That is not fatal. A rotated or cleared key leaves ciphertext nobody can
 * open, and the messages themselves are still on the relays - so an unreadable
 * cache costs a refetch, not history.
 */
export async function decryptJson<T>(payload: unknown): Promise<T | null> {
  if (!isEncryptedPayload(payload)) {
    return null;
  }
  const api: SubtleCrypto | null = subtle();
  const key: CryptoKey | null = await getKey();
  if (!api || !key) {
    return null;
  }

  try {
    const plaintext: ArrayBuffer = await api.decrypt(
      { name: 'AES-GCM', iv: payload.iv },
      key,
      payload.ct,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error: unknown) {
    console.warn('[dm] Failed to decrypt cache:', error);
    return null;
  }
}

/**
 * Throws the key away, making any ciphertext still on disk unreadable.
 *
 * Deleting rows asks the database to forget them; destroying the key means it
 * no longer matters whether it did. Used on logout, where the guarantee wanted
 * is that the next person to hold the device cannot read the last one's
 * conversations.
 */
export async function destroyCacheKey(): Promise<void> {
  keyPromise = null;
  try {
    await deleteSecret(KEY_SECRET_NAME);
  } catch {
    // Nothing stored, or no credential store on this platform.
  }
  try {
    await setMetadata(KEY_METADATA_KEY, null);
  } catch {
    // Best effort; the next generate replaces it regardless.
  }
}

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
 *
 * The cipher differs too, for a duller reason. AES-GCM is used wherever
 * `crypto.subtle` exists, which covers browsers and the Tauri WebView. React
 * Native has no SubtleCrypto at all, and there the choice was between shipping
 * a crypto library for one call and reusing NIP-44's, which is already here,
 * already audited as part of the protocol, and already doing exactly this job
 * one layer up. So the phone stores a v2 payload: NIP-44 with a random local
 * key, which is a symmetric key as far as that function is concerned.
 *
 * Without this the phone would simply not cache - the callers read a missing
 * cipher as "do not persist" - so every launch would re-fetch and re-decrypt
 * every conversation.
 */

import { nip44 } from 'nostr-tools';
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

/** AES-GCM, where `crypto.subtle` exists. */
export interface AesPayload {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

/** NIP-44 with a random local key, where it does not. */
export interface Nip44Payload {
  v: 2;
  ct: string;
}

export type EncryptedPayload = AesPayload | Nip44Payload;

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
  const candidate = value as { v?: unknown; iv?: unknown; ct?: unknown };
  if (candidate.v === 1) {
    return (
      candidate.iv instanceof Uint8Array && candidate.ct instanceof ArrayBuffer
    );
  }
  // A v2 blob written on the phone can be read back only on the phone, which
  // is true of a v1 blob too: neither key ever leaves the device it was made
  // on, so a cache is never carried between platforms in the first place.
  return candidate.v === 2 && typeof candidate.ct === 'string';
}

/**
 * The local key for the NIP-44 path.
 *
 * Kept beside the AES key rather than derived from it: they are alternatives,
 * never both live on one device, and a shared derivation would only tie two
 * unrelated lifetimes together.
 */
let localKeyPromise: Promise<Uint8Array | null> | null = null;

function getLocalKey(): Promise<Uint8Array | null> {
  if (!localKeyPromise) {
    localKeyPromise = (async (): Promise<Uint8Array | null> => {
      try {
        let raw: Uint8Array | null = await readSecret(KEY_SECRET_NAME);
        if (!raw || raw.length !== KEY_BYTES) {
          raw = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
          await writeSecret(KEY_SECRET_NAME, raw);
        }
        return raw;
      } catch (error: unknown) {
        console.warn('[dm] Local cache key unavailable:', error);
        return null;
      }
    })();
  }
  return localKeyPromise;
}

/** Returns null when no key is available, which means "do not write". */
export async function encryptJson(
  value: unknown,
): Promise<EncryptedPayload | null> {
  const api: SubtleCrypto | null = subtle();
  if (!api) {
    const localKey: Uint8Array | null = await getLocalKey();
    if (!localKey) {
      return null;
    }
    try {
      return { v: 2, ct: nip44.encrypt(JSON.stringify(value), localKey) };
    } catch (error: unknown) {
      console.warn('[dm] Failed to encrypt cache:', error);
      return null;
    }
  }

  const key: CryptoKey | null = await getKey();
  if (!key) {
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

  if (payload.v === 2) {
    const localKey: Uint8Array | null = await getLocalKey();
    if (!localKey) {
      return null;
    }
    try {
      return JSON.parse(nip44.decrypt(payload.ct, localKey)) as T;
    } catch (error: unknown) {
      console.warn('[dm] Failed to decrypt cache:', error);
      return null;
    }
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
  localKeyPromise = null;
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

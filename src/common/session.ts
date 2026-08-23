import { getPublicKey, nip19 } from 'nostr-tools';
import type { Npub, PubkeyHex } from '../../types/nostr';
import { isNativeRuntime } from './native-http.js';
import { deleteSecret, readSecret, writeSecret } from './secret-store.js';

let sessionPrivateKey: Uint8Array | null = null;
const PRIVATE_KEY_STORAGE_KEY: string = 'nostr_private_key';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex length');
  }
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

function parsePrivateKey(rawKey: string): Uint8Array {
  if (rawKey.startsWith('nsec')) {
    const decoded = nip19.decode(rawKey);
    if (decoded.type !== 'nsec') {
      throw new Error('Invalid nsec format');
    }
    const data = decoded.data;
    return typeof data === 'string' ? hexToBytes(data) : data;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error('Private key must be nsec or 64 hex chars');
  }
  return hexToBytes(rawKey);
}

/**
 * Loads the persisted key into memory.
 *
 * Reading the native credential store is asynchronous, but
 * `getSessionPrivateKey()` is called synchronously from roughly fifteen places,
 * including signing paths whose option types declare it sync. Restoring into
 * the in-memory cache once at startup keeps that contract intact.
 *
 * Boot must await this before routing: NIP-42 AUTH can fire during the first
 * timeline load, and an unrestored key would silently fail that handshake.
 */
export async function restoreSessionPrivateKey(): Promise<void> {
  if (sessionPrivateKey) {
    return;
  }

  try {
    sessionPrivateKey = await readSecret(PRIVATE_KEY_STORAGE_KEY);
  } catch (error: unknown) {
    console.warn('Failed to restore private key:', error);
  }
}

export function setSessionPrivateKeyFromRaw(rawKey: string): PubkeyHex {
  const secretBytes: Uint8Array = parsePrivateKey(rawKey);
  sessionPrivateKey = secretBytes;

  // Persisted in the background: callers depend on the pubkey returning
  // synchronously, and the in-memory cache already serves this session.
  void writeSecret(PRIVATE_KEY_STORAGE_KEY, secretBytes);

  return getPublicKey(secretBytes);
}

export function clearSessionPrivateKey(): void {
  sessionPrivateKey = null;
  void deleteSecret(PRIVATE_KEY_STORAGE_KEY);
}

/**
 * Returns the active key as an nsec, for the backup prompt.
 *
 * Reads only the in-memory cache, so it never widens where the key is exposed.
 */
export function getSessionNsec(): string | null {
  return sessionPrivateKey ? nip19.nsecEncode(sessionPrivateKey) : null;
}

export function getSessionPrivateKey(): Uint8Array | null {
  // Return cached value if available
  if (sessionPrivateKey) {
    return sessionPrivateKey;
  }

  // Natively the key lives in the credential store, which cannot be read
  // synchronously; restoreSessionPrivateKey() populates the cache at startup.
  if (isNativeRuntime()) {
    return null;
  }

  // Try to restore from localStorage first (persistent login), then migrate any old sessionStorage value.
  try {
    const storedHex: string | null = localStorage.getItem(
      PRIVATE_KEY_STORAGE_KEY,
    );
    if (storedHex) {
      sessionPrivateKey = hexToBytes(storedHex);
      return sessionPrivateKey;
    }

    const legacySessionHex: string | null = sessionStorage.getItem(
      PRIVATE_KEY_STORAGE_KEY,
    );
    if (legacySessionHex) {
      sessionPrivateKey = hexToBytes(legacySessionHex);
      localStorage.setItem(PRIVATE_KEY_STORAGE_KEY, legacySessionHex);
      sessionStorage.removeItem(PRIVATE_KEY_STORAGE_KEY);
      return sessionPrivateKey;
    }
  } catch (error: unknown) {
    console.warn('Failed to restore private key from storage:', error);
  }

  return null;
}

export function updateLogoutButton(composeButton: HTMLElement | null): void {
  const logoutButton: HTMLElement | null =
    document.getElementById('nav-logout');
  const profileLink: HTMLAnchorElement | null = document.getElementById(
    'nav-profile',
  ) as HTMLAnchorElement;
  const storedPubkey: string | null = localStorage.getItem('nostr_pubkey');

  if (logoutButton) {
    if (storedPubkey) {
      logoutButton.style.display = '';
    } else {
      logoutButton.style.display = 'none';
    }
  }

  if (profileLink) {
    if (storedPubkey) {
      try {
        const npub: Npub = storedPubkey.startsWith('npub')
          ? (storedPubkey as Npub)
          : nip19.npubEncode(storedPubkey);
        profileLink.href = `/${npub}`;
      } catch (e) {
        console.warn('Failed to build profile link from stored pubkey:', e);
        profileLink.href = '#';
      }
    } else {
      profileLink.href = '#';
    }
  }

  if (composeButton) {
    if (storedPubkey) {
      composeButton.style.display = '';
    } else {
      composeButton.style.display = 'none';
    }
  }
}

/**
 * Who this session is, and what it may do.
 *
 * Three kinds. Signed in: a key is here, in the session or in an extension,
 * and the person may publish. Read-only: someone gave a public key to look
 * through - their own, to try the app before trusting it with a secret, or
 * anybody's - and the screens are drawn for that key, but nothing may be
 * signed. None: nobody.
 *
 * Read-only is deliberately not a weaker sign-in. It is kept as its own
 * kind, stored under its own flag, and entering it throws away any private
 * key that was here, so the only way from read-only to signed in is to
 * leave and sign in properly. A public key is not a credential, and the
 * code must never be able to mistake it for one.
 */

import { getPublicKey, nip19 } from 'nostr-tools';
import type { Npub, PubkeyHex } from '../../types/nostr';
import { kvGet, kvRemove, kvSet } from './kv.js';
import { isNativeRuntime } from './native-http.js';
import { deleteSecret, readSecret, writeSecret } from './secret-store.js';

let sessionPrivateKey: Uint8Array | null = null;
const PRIVATE_KEY_STORAGE_KEY: string = 'nostr_private_key';

/** The public key every screen is drawn for, whatever kind of session. */
export const VIEWER_KEY: string = 'nostr_pubkey';
/** Present, with this value, only while browsing as a public key. */
const SESSION_KIND_KEY: string = 'nostr_session_kind';
const READ_ONLY: string = 'read-only';

export type SessionKind = 'none' | 'signed-in' | 'read-only';

export interface SessionState {
  kind: SessionKind;
  /** Null only when nobody is here. */
  pubkey: PubkeyHex | null;
}

/** Thrown where a read-only session reaches for a signature. */
export class ReadOnlySessionError extends Error {
  constructor() {
    super('This is a read-only session. Sign in to post.');
    this.name = 'ReadOnlySessionError';
  }
}

/** Thrown when the text somebody pasted is not a public key. */
export class InvalidPublicKeyError extends Error {
  constructor() {
    super('Enter an npub, an nprofile, or a 64-character hex public key.');
    this.name = 'InvalidPublicKeyError';
  }
}

/**
 * Reads a public key out of what somebody typed: npub, nprofile, or 64 hex
 * characters, with or without a `nostr:` prefix and surrounding space. An
 * nsec is refused here on purpose - the box this feeds is the one that
 * promises not to take a secret, and accepting one quietly would break
 * that promise in the worst way.
 */
export function parsePublicKey(input: string): PubkeyHex | null {
  const text: string = input.trim().replace(/^nostr:/i, '');
  if (/^[0-9a-f]{64}$/i.test(text)) {
    return text.toLowerCase() as PubkeyHex;
  }
  try {
    const decoded = nip19.decode(text.toLowerCase());
    if (decoded.type === 'npub') {
      return decoded.data as PubkeyHex;
    }
    if (decoded.type === 'nprofile') {
      return (decoded.data as { pubkey: string }).pubkey as PubkeyHex;
    }
  } catch {
    // Not bech32, or not a kind this reads.
  }
  return null;
}

export function getSession(): SessionState {
  const pubkey: string | null = kvGet(VIEWER_KEY);
  if (!pubkey) {
    return { kind: 'none', pubkey: null };
  }
  return {
    kind: kvGet(SESSION_KIND_KEY) === READ_ONLY ? 'read-only' : 'signed-in',
    pubkey: pubkey as PubkeyHex,
  };
}

export function isReadOnlySession(): boolean {
  return getSession().kind === 'read-only';
}

/**
 * Starts browsing as a public key.
 *
 * Any private key here is thrown away first: a read-only session must not
 * be able to sign, and the simplest way to be sure is for there to be no
 * key. Returns the pubkey the screens will be drawn for.
 */
export function startReadOnlySession(input: string): PubkeyHex {
  const pubkey: PubkeyHex | null = parsePublicKey(input);
  if (!pubkey) {
    throw new InvalidPublicKeyError();
  }
  clearSessionPrivateKey();
  kvSet(SESSION_KIND_KEY, READ_ONLY);
  kvSet(VIEWER_KEY, pubkey);
  return pubkey;
}

/**
 * Records a real sign-in - an extension, or a key just loaded - as the
 * session. Whatever read-only state was here ends; the two are never
 * layered.
 */
export function beginSignedInSession(pubkey: PubkeyHex): void {
  kvRemove(SESSION_KIND_KEY);
  kvSet(VIEWER_KEY, pubkey);
}

/** Ends whichever kind of session this is. */
export function endSession(): void {
  kvRemove(SESSION_KIND_KEY);
  kvRemove(VIEWER_KEY);
  clearSessionPrivateKey();
}

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

  const pubkey: PubkeyHex = getPublicKey(secretBytes);
  // A key arriving is a sign-in, and a sign-in is never read-only.
  beginSignedInSession(pubkey);
  return pubkey;
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
  // Belt and braces: entering read-only clears the key, and this makes sure
  // a key that somehow survived - a race with the async delete, a storage
  // copy this build does not know about - is still never handed out.
  if (isReadOnlySession()) {
    return null;
  }
  // Return cached value if available
  if (sessionPrivateKey) {
    return sessionPrivateKey;
  }

  // Where the key lives in a credential store it cannot be read
  // synchronously, and restoreSessionPrivateKey() populates the cache at
  // start-up instead. `isNativeRuntime()` answers that for Tauri; React
  // Native is the same situation but is not Tauri, and is recognised by
  // having no localStorage at all.
  //
  // Without the second test the code below would still return null, because
  // the throw is caught - but by accident rather than on purpose, and an
  // accident is not something the next reader can rely on.
  if (isNativeRuntime() || typeof localStorage === 'undefined') {
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
  const session: SessionState = getSession();
  const storedPubkey: string | null = session.pubkey;

  // Always on screen while browsing, so a read-only session cannot be
  // mistaken for a sign-in - and named for whose eyes these are.
  const pill: HTMLElement | null = document.getElementById('nav-readonly');
  if (pill) {
    const browsing: boolean = session.kind === 'read-only';
    pill.style.display = browsing ? '' : 'none';
    const text: HTMLElement | null =
      document.getElementById('nav-readonly-text');
    if (text && browsing && storedPubkey) {
      const npub: string = nip19.npubEncode(storedPubkey);
      text.textContent = `${npub.slice(0, 14)}…`;
      pill.title = `Browsing as ${npub}. Nothing can be posted.`;
    }
  }

  if (logoutButton) {
    logoutButton.style.display = storedPubkey ? '' : 'none';
    // The way out is named for what it leaves. "Logout" from a session
    // nobody logged into would be a small lie.
    logoutButton.textContent =
      session.kind === 'read-only' ? '👁 Stop browsing' : '🚪 Logout';
  }

  // The way in, in the place the way out would be.
  const signInButton: HTMLElement | null =
    document.getElementById('nav-signin');
  if (signInButton) {
    signInButton.style.display = storedPubkey ? 'none' : '';
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
    // Read-only has nothing to say; hiding the pencil is honest, and the
    // action buttons on each post stay visible to explain why.
    composeButton.style.display =
      storedPubkey && session.kind !== 'read-only' ? '' : 'none';
  }
}

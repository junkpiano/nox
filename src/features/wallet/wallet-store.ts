/**
 * Persistence for the wallet connection.
 *
 * The connection secret is a spending key: anyone holding it can move funds
 * within whatever budget the wallet grants. It goes in the platform credential
 * store alongside the Nostr private key, never in localStorage.
 *
 * The rest of the connection - wallet pubkey, relay, lightning address - is not
 * sensitive on its own and lives in the regular cache, so the wallet can be
 * recognised before the secret is read.
 */

import { getMetadata, setMetadata } from '../../common/db/index.js';
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from '../../common/secret-store.js';
import type { NwcConnection } from './nwc-client.js';

const SECRET_KEY: string = 'nwc_secret';
const META_KEY: string = 'nwc_connection_v1';

interface StoredConnectionMeta {
  walletPubkey: string;
  relay: string;
  lud16?: string;
  alias?: string;
}

let cached: NwcConnection | null = null;
let loaded: boolean = false;

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function announceChange(): void {
  window.dispatchEvent(new CustomEvent('wallet-connection-changed'));
}

/**
 * Loads the stored connection, if any.
 *
 * Cached after the first call: reading the credential store is asynchronous,
 * and the zap flow needs to know synchronously whether a wallet is available.
 */
export async function loadWalletConnection(): Promise<NwcConnection | null> {
  if (loaded) {
    return cached;
  }

  try {
    const meta = await getMetadata<StoredConnectionMeta>(META_KEY);
    if (!meta?.walletPubkey) {
      loaded = true;
      return null;
    }

    const secretBytes: Uint8Array | null = await readSecret(SECRET_KEY);
    if (!secretBytes) {
      // Metadata without a secret means the credential store was cleared. Treat
      // it as disconnected rather than half-configured.
      loaded = true;
      return null;
    }

    cached = {
      walletPubkey: meta.walletPubkey,
      relay: meta.relay,
      secret: bytesToUtf8(secretBytes),
      ...(meta.lud16 ? { lud16: meta.lud16 } : {}),
    };
  } catch (error: unknown) {
    console.warn('[wallet] Failed to load the wallet connection:', error);
  }

  loaded = true;
  return cached;
}

/**
 * Whether a wallet is connected, without touching storage.
 *
 * Only meaningful after loadWalletConnection() has run at startup.
 */
export function hasWalletConnection(): boolean {
  return cached !== null;
}

export function getWalletConnection(): NwcConnection | null {
  return cached;
}

export async function saveWalletConnection(
  connection: NwcConnection,
  alias?: string,
): Promise<void> {
  await writeSecret(SECRET_KEY, utf8ToBytes(connection.secret));
  await setMetadata(META_KEY, {
    walletPubkey: connection.walletPubkey,
    relay: connection.relay,
    ...(connection.lud16 ? { lud16: connection.lud16 } : {}),
    ...(alias ? { alias } : {}),
  } satisfies StoredConnectionMeta);

  cached = connection;
  loaded = true;
  announceChange();
}

export async function getWalletAlias(): Promise<string | null> {
  try {
    const meta = await getMetadata<StoredConnectionMeta>(META_KEY);
    return meta?.alias ?? null;
  } catch {
    return null;
  }
}

/** Removes the connection. The wallet itself is untouched. */
export async function clearWalletConnection(): Promise<void> {
  cached = null;
  loaded = true;
  await deleteSecret(SECRET_KEY);
  await setMetadata(META_KEY, null);
  announceChange();
}

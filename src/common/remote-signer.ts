/**
 * Signing with a key held somewhere else: NIP-46, a "remote signer".
 *
 * A phone browser has no extension, and a pasted key on the web lives in
 * localStorage where any script on the page can read it. A remote signer
 * (an app such as Amber, or a service such as nsec.app) keeps the key and
 * signs on request over a relay, so the page never holds it.
 *
 * The rest of the app already speaks NIP-07 - `window.nostr` - in fifteen
 * places, private messages and the mute list included, which need NIP-44
 * as well as signatures. So a connected signer is put there, shaped like an
 * extension, rather than taught to fifteen call sites.
 *
 * What is kept between visits: a throwaway key this browser uses to talk to
 * the signer, through `secret-store` like any other key, and the signer's
 * address. The throwaway key can ask the signer for whatever it was allowed
 * to do, so it is cleared on sign-out like a secret key.
 */

import { generateSecretKey, SimplePool } from 'nostr-tools';
import {
  type BunkerPointer,
  BunkerSigner,
  parseBunkerInput,
} from 'nostr-tools/nip46';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { kvGet, kvRemove, kvSet } from './kv.js';
import { deleteSecret, readSecret, writeSecret } from './secret-store.js';
import { beginSignedInSession, VIEWER_KEY } from './session.js';

const CLIENT_KEY: string = 'nostr_remote_signer_client_key';
const POINTER_KEY: string = 'nostr_remote_signer';
/** Long enough to unlock a phone and approve; a signer that never answers is not waited on forever. */
const ANSWER_TIMEOUT_MS: number = 90_000;

type Encrypt = (pubkey: string, text: string) => Promise<string>;

/** What `window.nostr` offers while a remote signer is connected. */
interface Nip07Shape {
  getPublicKey: () => Promise<string>;
  signEvent: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  nip04: { encrypt: Encrypt; decrypt: Encrypt };
  nip44: { encrypt: Encrypt; decrypt: Encrypt };
}

interface Connection {
  signer: BunkerSigner;
  pool: SimplePool;
  shape: Nip07Shape;
  /** Whatever `window.nostr` was before, put back on sign-out. */
  previous: unknown;
}

let current: Connection | null = null;
/**
 * Bumped on every sign-out. A connection waiting on approval checks it
 * before it finishes: one approved after the person gave up, or signed in
 * some other way, must not replace that session.
 */
let generation: number = 0;

export class NotABunkerAddressError extends Error {
  constructor() {
    super('That is not a bunker:// address or a name@domain with a signer.');
    this.name = 'NotABunkerAddressError';
  }
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      (): void => reject(new Error(`The signer did not answer (${what}).`)),
      ANSWER_TIMEOUT_MS,
    );
    promise.then(
      (value: T): void => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown): void => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The signer's approval page, if it is a web page; anything else is dropped. */
function approvalUrl(url: string): string | null {
  try {
    const parsed: URL = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Shown when the signer asks for approval after sign-in - after a reload,
 * say, when no sign-in screen is there to show the link. One at a time.
 */
function showApprovalBanner(url: string): void {
  document.getElementById('nox-signer-approval')?.remove();
  const banner: HTMLDivElement = document.createElement('div');
  banner.id = 'nox-signer-approval';
  banner.className = 'nox-signer-approval';
  banner.setAttribute('role', 'status');
  const link: HTMLAnchorElement = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Approve in your signer';
  link.addEventListener('click', (): void => banner.remove());
  banner.append('Your signer is waiting. ', link);
  document.body.appendChild(banner);
}

function makeSigner(
  clientKey: Uint8Array,
  pointer: BunkerPointer,
  onApproval: (url: string) => void,
): { signer: BunkerSigner; pool: SimplePool } {
  const pool: SimplePool = new SimplePool();
  const signer: BunkerSigner = BunkerSigner.fromBunker(clientKey, pointer, {
    pool,
    onauth: (url: string): void => {
      const safe: string | null = approvalUrl(url);
      if (safe) onApproval(safe);
    },
  });
  return { signer, pool };
}

/** Puts the signer where the app looks for a NIP-07 extension. */
function install(
  signer: BunkerSigner,
  pool: SimplePool,
  pubkey: PubkeyHex,
): void {
  const ask = <T>(promise: Promise<T>, what: string): Promise<T> =>
    withTimeout(promise, what);
  const shape: Nip07Shape = {
    getPublicKey: async (): Promise<string> => pubkey,
    signEvent: async (event): Promise<NostrEvent> => {
      // Only the fields NIP-46 asks for: a signer may refuse an event that
      // names a pubkey, and it fills in its own.
      const template = {
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      };
      const signed = (await ask(
        signer.signEvent(template),
        'sign',
      )) as NostrEvent;
      // The signature is checked by the library; what was signed is not.
      // The event must be the one asked for, by the person signed in.
      if (
        signed.pubkey !== pubkey ||
        signed.kind !== template.kind ||
        signed.created_at !== template.created_at ||
        signed.content !== template.content ||
        JSON.stringify(signed.tags) !== JSON.stringify(template.tags)
      ) {
        throw new Error('The signer returned a different event.');
      }
      return signed;
    },
    nip04: {
      encrypt: (other, text) =>
        ask(signer.nip04Encrypt(other, text), 'encrypt'),
      decrypt: (other, text) =>
        ask(signer.nip04Decrypt(other, text), 'decrypt'),
    },
    nip44: {
      encrypt: (other, text) =>
        ask(signer.nip44Encrypt(other, text), 'encrypt'),
      decrypt: (other, text) =>
        ask(signer.nip44Decrypt(other, text), 'decrypt'),
    },
  };
  const previous: unknown = (window as { nostr?: unknown }).nostr;
  // An extension may have defined `nostr` so that it cannot be replaced;
  // then it is the extension that signs, and saying so beats signing as
  // someone else.
  try {
    Object.defineProperty(window, 'nostr', {
      value: shape,
      configurable: true,
      writable: true,
    });
  } catch {
    throw new Error(
      'A browser extension is in the way. Disable it to use a remote signer.',
    );
  }
  if ((window as { nostr?: unknown }).nostr !== shape) {
    throw new Error(
      'A browser extension is in the way. Disable it to use a remote signer.',
    );
  }
  current = { signer, pool, shape, previous };
}

/** Takes the adapter back off `window.nostr`, and only if it is still ours. */
function uninstall(): Connection | null {
  const connection: Connection | null = current;
  current = null;
  if (!connection) return null;
  const win = window as { nostr?: unknown };
  if (win.nostr === connection.shape) {
    try {
      if (connection.previous === undefined) delete win.nostr;
      else win.nostr = connection.previous;
    } catch {
      // Left as it is; nothing more can be done from here.
    }
  }
  return connection;
}

function shutDown(connection: Connection | null): void {
  if (!connection) return;
  void connection.signer.close().catch((): void => {});
  try {
    connection.pool.destroy();
  } catch {
    // Already gone.
  }
}

/** Whether this session signs through a remote signer. */
export function isRemoteSignerSession(): boolean {
  return current !== null;
}

/**
 * Connects to the signer at `input` and signs in as whoever it signs for.
 *
 * `onApproval` gets a link when the signer wants the person to approve the
 * connection in a page of its own; a popup opened after a network wait is
 * one a browser blocks, so the caller shows the link instead.
 */
export async function connectRemoteSigner(
  input: string,
  onApproval: (url: string) => void,
): Promise<PubkeyHex> {
  const started: number = generation;
  const pointer: BunkerPointer | null = await parseBunkerInput(input.trim());
  if (!pointer) throw new NotABunkerAddressError();

  const clientKey: Uint8Array = generateSecretKey();
  // The sign-in screen shows the first approval; once connected, it has
  // gone, and later ones (a post, a message) come as the banner.
  let connected: boolean = false;
  const { signer, pool } = makeSigner(clientKey, pointer, (url: string) =>
    connected ? showApprovalBanner(url) : onApproval(url),
  );
  const abandon = (): void =>
    shutDown({ signer, pool, shape: {} as Nip07Shape, previous: undefined });
  try {
    await withTimeout(signer.connect(), 'connect');
    const pubkey: string = await withTimeout(
      signer.getPublicKey(),
      'public key',
    );
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      throw new Error('The signer gave a public key that is not one.');
    }
    // Signed out, or signed in another way, while this waited for approval.
    if (started !== generation || kvGet(VIEWER_KEY)) {
      throw new Error('Signing in was cancelled.');
    }
    install(signer, pool, pubkey as PubkeyHex);
    try {
      await writeSecret(CLIENT_KEY, clientKey);
      // The connection secret is single-use; the next visit reconnects by
      // this browser's key, which the signer now knows.
      kvSet(POINTER_KEY, JSON.stringify({ ...pointer, secret: null }));
      if (started !== generation || kvGet(VIEWER_KEY)) {
        throw new Error('Signing in was cancelled.');
      }
    } catch (error: unknown) {
      uninstall();
      kvRemove(POINTER_KEY);
      void deleteSecret(CLIENT_KEY).catch((): void => {});
      throw error;
    }
    connected = true;
    beginSignedInSession(pubkey as PubkeyHex);
    return pubkey as PubkeyHex;
  } catch (error: unknown) {
    if (current?.signer !== signer) abandon();
    throw error;
  }
}

/**
 * Reconnects at startup when the last session was a remote signer.
 *
 * Before routing, as the stored key is restored: the first timeline load can
 * meet a relay asking for AUTH, and that needs a signer in place.
 */
export async function restoreRemoteSigner(): Promise<void> {
  const raw: string | null = kvGet(POINTER_KEY);
  const pubkey: string | null = kvGet(VIEWER_KEY);
  if (!raw || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return;
  const started: number = generation;
  let made: { signer: BunkerSigner; pool: SimplePool } | null = null;
  try {
    const clientKey: Uint8Array | null = await readSecret(CLIENT_KEY);
    // Signed out, or someone else signed in, while the key was read.
    if (!clientKey || started !== generation || kvGet(VIEWER_KEY) !== pubkey) {
      return;
    }
    const pointer: BunkerPointer = JSON.parse(raw) as BunkerPointer;
    made = makeSigner(clientKey, pointer, showApprovalBanner);
    install(made.signer, made.pool, pubkey as PubkeyHex);
  } catch (error: unknown) {
    console.warn('[remote-signer] Could not restore the connection:', error);
    if (made && current?.signer !== made.signer) {
      shutDown({ ...made, shape: {} as Nip07Shape, previous: undefined });
    }
  }
}

/** Forgets the signer: on sign-out, nothing that could reconnect is kept. */
export async function disconnectRemoteSigner(): Promise<void> {
  generation += 1;
  const connection: Connection | null = uninstall();
  kvRemove(POINTER_KEY);
  document.getElementById('nox-signer-approval')?.remove();
  try {
    await deleteSecret(CLIENT_KEY);
  } finally {
    shutDown(connection);
  }
}

/**
 * The one place an event gets a signature.
 *
 * There were sixteen copies of "extension if there is one, otherwise the
 * session key, otherwise an error", one per kind of thing this app
 * publishes. Sixteen copies is sixteen places a rule about signing has to
 * be remembered, and the rule that matters now is one none of them knew:
 * a read-only session must never sign. Someone browsing as a public key
 * has no key to sign with - but their browser may still have an extension
 * that would, and a stray code path that reached it would publish under
 * a name the person only meant to look through.
 *
 * So every signature comes through here, and here refuses first.
 */

import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';
import {
  getSessionPrivateKey,
  isReadOnlySession,
  ReadOnlySessionError,
} from './session.js';

/**
 * An event before it is signed: everything but the id and the signature.
 * The pubkey is optional because the signer knows it - an extension fills
 * it in, and `finalizeEvent` derives it from the key.
 */
export type UnsignedEvent = Omit<NostrEvent, 'id' | 'sig' | 'pubkey'> & {
  pubkey?: string;
};

/** The part of NIP-07 this needs. */
interface ExtensionSigner {
  signEvent: (event: UnsignedEvent) => Promise<NostrEvent>;
}

/** Nothing here can sign: no extension, no key in the session. */
export class NoSigningMethodError extends Error {
  constructor() {
    super('No signing method available (extension or private key required).');
    this.name = 'NoSigningMethodError';
  }
}

/** The browser extension's signer, when there is one. Never on a phone. */
export function extensionSigner(): ExtensionSigner | null {
  if (typeof window === 'undefined') return null;
  const nostr = (window as { nostr?: Partial<ExtensionSigner> }).nostr;
  return typeof nostr?.signEvent === 'function'
    ? (nostr as ExtensionSigner)
    : null;
}

/** Whether a signature could be produced at all, before trying. */
export function hasSigner(): boolean {
  return extensionSigner() !== null || getSessionPrivateKey() !== null;
}

/**
 * Whether this session may publish: not read-only, and able to sign. The
 * question every write control asks before drawing itself enabled.
 */
export function canWrite(): boolean {
  return !isReadOnlySession() && hasSigner();
}

/**
 * Signs with whatever holds the key - unless the session is read-only, in
 * which case nothing holds it and nothing is allowed to pretend to.
 *
 * Throws `ReadOnlySessionError` or `NoSigningMethodError`; callers that
 * have a screen to speak to turn those into a sentence.
 */
export async function signWithSession(
  unsigned: UnsignedEvent,
): Promise<NostrEvent> {
  if (isReadOnlySession()) {
    throw new ReadOnlySessionError();
  }
  const extension: ExtensionSigner | null = extensionSigner();
  if (extension) {
    return extension.signEvent(unsigned);
  }
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (!privateKey) {
    throw new NoSigningMethodError();
  }
  return finalizeEvent(unsigned, privateKey) as NostrEvent;
}

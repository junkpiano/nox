/**
 * NIP-09: asking the relays to forget a post.
 *
 * A request, not an erasure. Relays are free to keep it and some do, copies
 * other people already hold are theirs, and a client that ignores kind 5 will
 * go on showing it. Anywhere this is offered should say "ask" rather than
 * "delete", and the local copy is dropped whatever the relays decide.
 *
 * The signing lives here rather than in the web card renderer, where it was,
 * because the phone needs the same thing and the alternative was a second
 * implementation of a destructive operation. Publishing goes through the
 * shared publisher, so a relay that rejects it is reported the same way as
 * anywhere else.
 */

import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { withClientTag } from './client-tag.js';
import { kvGet } from './kv.js';
import { publishEventToRelays } from './publish-event.js';
import { getSessionPrivateKey } from './session.js';

interface Nip07 {
  signEvent?: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
}

function extension(): Nip07 | null {
  return (window as unknown as { nostr?: Nip07 }).nostr ?? null;
}

/**
 * Signs a kind:5 naming `target` and publishes it.
 *
 * Refuses to sign for anybody else's post. A deletion is only honoured from
 * the author, so signing one would produce an event every relay drops -
 * failing loudly beats publishing nothing and reporting success.
 */
export async function requestDeletion(
  target: NostrEvent,
  relays: string[],
): Promise<void> {
  const viewer: string | null = kvGet('nostr_pubkey');
  if (!viewer || viewer.toLowerCase() !== target.pubkey.toLowerCase()) {
    throw new Error('You can only delete your own posts.');
  }

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = withClientTag({
    kind: 5,
    pubkey: viewer as PubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['e', target.id]],
    content: '',
  });

  const nip07: Nip07 | null = extension();
  let signedEvent: NostrEvent;
  if (nip07?.signEvent) {
    signedEvent = await nip07.signEvent(unsignedEvent);
  } else {
    const privateKey: Uint8Array | null = getSessionPrivateKey();
    if (!privateKey) {
      throw new Error('No signing method available');
    }
    signedEvent = finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
  }

  await publishEventToRelays(signedEvent, relays);
}

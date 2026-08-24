/**
 * NIP-51 kind:10000 mute list.
 *
 * The list is kept private: entries live in NIP-44 encrypted `content` rather
 * than public `p` tags, so relays and other users cannot read who the viewer
 * has blocked. Only user mutes are handled; the `word`, `t` and `e` targets the
 * spec allows are out of scope.
 */

import { finalizeEvent, nip44 } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { getSessionPrivateKey } from '../../common/session.js';

export const MUTE_LIST_KIND: number = 10000;

interface Nip07Nip44 {
  encrypt: (pubkey: string, plaintext: string) => Promise<string>;
  decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
}

function getExtension(): {
  signEvent?: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  nip44?: Nip07Nip44;
} | null {
  return (
    (window as unknown as { nostr?: ReturnType<typeof getExtension> }).nostr ??
    null
  );
}

/**
 * Encrypts to the viewer's own key, which is how NIP-51 stores private entries.
 */
async function encryptToSelf(
  plaintext: string,
  pubkeyHex: PubkeyHex,
): Promise<string> {
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (privateKey) {
    const conversationKey: Uint8Array = nip44.getConversationKey(
      privateKey,
      pubkeyHex,
    );
    return nip44.encrypt(plaintext, conversationKey);
  }

  const extensionNip44 = getExtension()?.nip44;
  if (extensionNip44) {
    return extensionNip44.encrypt(pubkeyHex, plaintext);
  }

  throw new Error('No key available to encrypt the mute list.');
}

async function decryptFromSelf(
  ciphertext: string,
  pubkeyHex: PubkeyHex,
): Promise<string> {
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (privateKey) {
    const conversationKey: Uint8Array = nip44.getConversationKey(
      privateKey,
      pubkeyHex,
    );
    return nip44.decrypt(ciphertext, conversationKey);
  }

  const extensionNip44 = getExtension()?.nip44;
  if (extensionNip44) {
    return extensionNip44.decrypt(pubkeyHex, ciphertext);
  }

  throw new Error('No key available to decrypt the mute list.');
}

function collectPubkeysFromTags(tags: unknown): PubkeyHex[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  const pubkeys: PubkeyHex[] = [];
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string') {
      pubkeys.push(tag[1] as PubkeyHex);
    }
  }
  return pubkeys;
}

/**
 * Reads muted pubkeys out of a kind:10000 event.
 *
 * Public `p` tags are read too. This client writes private entries only, but
 * the user may have a list from another client, and dropping those silently
 * would un-mute people behind their back.
 */
export async function parseMuteListEvent(
  event: NostrEvent,
  viewerPubkey: PubkeyHex,
): Promise<PubkeyHex[]> {
  const pubkeys: Set<PubkeyHex> = new Set(collectPubkeysFromTags(event.tags));

  if (event.content) {
    try {
      const plaintext: string = await decryptFromSelf(
        event.content,
        viewerPubkey,
      );
      for (const pubkey of collectPubkeysFromTags(JSON.parse(plaintext))) {
        pubkeys.add(pubkey);
      }
    } catch (error: unknown) {
      // A list encrypted for a different key, or NIP-04 content from an older
      // client. Better to keep the public entries than to fail the whole list.
      console.warn('[mute] Failed to decrypt private mute entries:', error);
    }
  }

  return Array.from(pubkeys);
}

/**
 * Builds a signed kind:10000 event carrying every entry in encrypted content.
 */
export async function signMuteListEvent(params: {
  pubkeyHex: PubkeyHex;
  mutedPubkeys: PubkeyHex[];
}): Promise<NostrEvent> {
  const privateTags: string[][] = params.mutedPubkeys.map(
    (pubkey: PubkeyHex): string[] => ['p', pubkey],
  );

  const unsignedEvent: Omit<NostrEvent, 'id' | 'sig'> = {
    kind: MUTE_LIST_KIND,
    pubkey: params.pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: await encryptToSelf(JSON.stringify(privateTags), params.pubkeyHex),
  };

  const extension = getExtension();
  if (extension?.signEvent) {
    return extension.signEvent(unsignedEvent);
  }

  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (!privateKey) {
    throw new Error(
      'No signing method available (extension or private key required).',
    );
  }
  return finalizeEvent(unsignedEvent, privateKey) as NostrEvent;
}

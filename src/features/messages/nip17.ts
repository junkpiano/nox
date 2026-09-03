import {
  isReadOnlySession,
  ReadOnlySessionError,
} from '../../common/session.js';
/**
 * NIP-17 private direct messages.
 *
 * A message is a kind 14 rumor that is never signed, sealed in a kind 13 event
 * signed by the sender, then gift-wrapped in a kind 1059 event signed by a
 * throwaway key. Only the wrap is public, and it reveals nothing about who is
 * talking to whom.
 *
 * `nostr-tools` implements all of this, but only against a raw private key. A
 * NIP-07 extension never hands one over, so the sealing steps are written out
 * here against an abstract signer that both key sources satisfy.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  nip44,
} from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { getSessionPrivateKey } from '../../common/session.js';

export const CHAT_KIND: number = 14;
const SEAL_KIND: number = 13;
export const GIFT_WRAP_KIND: number = 1059;

/** A kind 14 chat message. Never signed, so it can never be published as-is. */
export interface ChatRumor {
  id: string;
  pubkey: PubkeyHex;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

interface Nip07 {
  getPublicKey?: () => Promise<string>;
  signEvent?: (event: Omit<NostrEvent, 'id' | 'sig'>) => Promise<NostrEvent>;
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

function getExtension(): Nip07 | null {
  return (window as unknown as { nostr?: Nip07 }).nostr ?? null;
}

/** Whether this device can read and write DMs at all. */
export function canUseDirectMessages(): boolean {
  if (getSessionPrivateKey()) {
    return true;
  }
  const extension = getExtension();
  return Boolean(extension?.nip44 && extension.signEvent);
}

async function encryptFor(
  recipient: string,
  plaintext: string,
): Promise<string> {
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (privateKey) {
    return nip44.encrypt(
      plaintext,
      nip44.getConversationKey(privateKey, recipient),
    );
  }

  const extensionNip44 = getExtension()?.nip44;
  if (!extensionNip44) {
    throw new Error('No key available to encrypt messages.');
  }
  return extensionNip44.encrypt(recipient, plaintext);
}

async function decryptFrom(
  sender: string,
  ciphertext: string,
): Promise<string> {
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (privateKey) {
    return nip44.decrypt(
      ciphertext,
      nip44.getConversationKey(privateKey, sender),
    );
  }

  const extensionNip44 = getExtension()?.nip44;
  if (!extensionNip44) {
    throw new Error('No key available to decrypt messages.');
  }
  return extensionNip44.decrypt(sender, ciphertext);
}

async function signAsUser(
  event: Omit<NostrEvent, 'id' | 'sig'>,
): Promise<NostrEvent> {
  if (isReadOnlySession()) {
    throw new ReadOnlySessionError();
  }
  const privateKey: Uint8Array | null = getSessionPrivateKey();
  if (privateKey) {
    return finalizeEvent(event, privateKey) as NostrEvent;
  }

  const signEvent = getExtension()?.signEvent;
  if (!signEvent) {
    throw new Error('No signing method available.');
  }
  return signEvent(event);
}

/**
 * Timestamps are randomised up to two days into the past.
 *
 * NIP-59 asks for this: the wrap's own timestamp is public, and leaving it
 * exact would leak when a conversation happened even though its contents stay
 * private.
 */
function jitteredTimestamp(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172_800);
}

/**
 * Builds the gift wraps for one message.
 *
 * Two are produced: one addressed to the recipient, one back to the sender, so
 * the sender's own history survives on relays they can read.
 */
export async function buildGiftWraps(params: {
  senderPubkey: PubkeyHex;
  recipientPubkey: PubkeyHex;
  message: string;
  replyToEventId?: string;
}): Promise<NostrEvent[]> {
  const tags: string[][] = [['p', params.recipientPubkey]];
  if (params.replyToEventId) {
    tags.push(['e', params.replyToEventId]);
  }

  const rumor: ChatRumor = {
    id: '',
    pubkey: params.senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: CHAT_KIND,
    tags,
    content: params.message,
  };
  rumor.id = getEventHash(
    rumor as unknown as Parameters<typeof getEventHash>[0],
  );

  const wraps: NostrEvent[] = [];
  for (const target of [params.recipientPubkey, params.senderPubkey]) {
    const seal: NostrEvent = await signAsUser({
      kind: SEAL_KIND,
      pubkey: params.senderPubkey,
      created_at: jitteredTimestamp(),
      tags: [],
      content: await encryptFor(target, JSON.stringify(rumor)),
    });

    // The wrap is signed by a throwaway key, so nothing links it to the sender.
    const wrapKey: Uint8Array = generateSecretKey();
    wraps.push(
      finalizeEvent(
        {
          kind: GIFT_WRAP_KIND,
          created_at: jitteredTimestamp(),
          tags: [['p', target]],
          content: nip44.encrypt(
            JSON.stringify(seal),
            nip44.getConversationKey(wrapKey, target),
          ),
        },
        wrapKey,
      ) as NostrEvent,
    );
  }

  return wraps;
}

/**
 * Recovers the chat message inside a gift wrap.
 *
 * Returns null for anything that does not unwrap to a message this client
 * understands. A relay will happily hand over wraps meant for other clients.
 */
export async function unwrapChatMessage(
  wrap: NostrEvent,
): Promise<ChatRumor | null> {
  try {
    const sealJson: string = await decryptFrom(wrap.pubkey, wrap.content);
    const seal = JSON.parse(sealJson) as NostrEvent;
    if (seal.kind !== SEAL_KIND) {
      return null;
    }

    const rumorJson: string = await decryptFrom(seal.pubkey, seal.content);
    const rumor = JSON.parse(rumorJson) as ChatRumor;
    if (rumor.kind !== CHAT_KIND) {
      return null;
    }

    // The seal is the only signed proof of authorship; a rumor claiming a
    // different author than the seal that carried it is forged.
    if (rumor.pubkey !== seal.pubkey) {
      return null;
    }

    return rumor;
  } catch {
    // Wraps addressed to someone else, or written by a client using different
    // conventions, are expected and not worth logging.
    return null;
  }
}

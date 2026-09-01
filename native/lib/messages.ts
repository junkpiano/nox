/**
 * Private messages, arranged for the phone.
 *
 * Everything that matters is the web app's: gift wrapping, the DM relay list,
 * the encrypted cache, the sync loop. What is written here is the same thing
 * the timeline module does - attaching names and faces to pubkeys, which the
 * protocol layer has no business knowing about.
 */

import type {
  Conversation,
  StoredMessage,
} from '../../src/features/messages/messages-store';
import {
  getConversation,
  getConversations,
  loadCachedMessages,
} from '../../src/features/messages/messages-store';
import {
  sendDirectMessage,
  startMessageSync,
  stopMessageSync,
} from '../../src/features/messages/messages-sync';
import { resolveRecipient } from '../../src/features/messages/resolve-recipient';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import { fetchProfilesForPubkeys } from './home-timeline';

export interface ConversationRow {
  peer: PubkeyHex;
  name: string;
  picture: string | null;
  preview: string;
  createdAt: number;
  messageCount: number;
}

/**
 * The conversation list, with names.
 *
 * Profiles are fetched for the peers on screen only. A pubkey is a correct
 * label and an unusable one; a screen full of hex is not a message list.
 */
export async function loadConversations(): Promise<ConversationRow[]> {
  await loadCachedMessages();
  const conversations: Conversation[] = getConversations();
  if (conversations.length === 0) {
    return [];
  }

  const profiles = await fetchProfilesForPubkeys(
    conversations.map(
      (conversation: Conversation): PubkeyHex => conversation.peer,
    ),
  );

  return conversations.map((conversation: Conversation): ConversationRow => {
    const meta = profiles.get(conversation.peer);
    return {
      peer: conversation.peer,
      name: meta?.name || `${conversation.peer.slice(0, 8)}...`,
      picture: meta?.picture ?? null,
      preview: conversation.lastMessage.content,
      createdAt: conversation.lastMessage.createdAt,
      messageCount: conversation.messageCount,
    };
  });
}

export function readConversation(peer: PubkeyHex): StoredMessage[] {
  return getConversation(peer);
}

/** Starts listening. Returns the teardown, or null when there is no viewer. */
export async function beginMessages(
  viewer: PubkeyHex,
): Promise<(() => void) | null> {
  try {
    return await startMessageSync(viewer, getRelays());
  } catch (error: unknown) {
    console.warn('[dm] Could not start message sync:', error);
    return null;
  }
}

export function endMessages(): void {
  stopMessageSync();
}

export { resolveRecipient };

export async function send(
  sender: PubkeyHex,
  peer: PubkeyHex,
  message: string,
): Promise<{ deliveredToRecipientRelays: boolean; usedFallback: boolean }> {
  return sendDirectMessage({
    senderPubkey: sender,
    recipientPubkey: peer,
    message,
    relays: getRelays(),
  });
}

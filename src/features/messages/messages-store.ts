/**
 * Decrypted message cache and conversation grouping.
 *
 * Unwrapping a gift wrap costs a NIP-44 decryption per message, so results are
 * cached rather than recomputed on every visit. The cache lives in the same
 * IndexedDB the rest of the app uses; these messages are already on this
 * device, and re-fetching them would mean decrypting them again anyway.
 */

import type { PubkeyHex } from '../../../types/nostr';
import { getMetadata, setMetadata } from '../../common/db/index.js';
import type { ChatRumor } from './nip17.js';

const CACHE_KEY: string = 'dm_messages_v1';

/** Bounded so a busy account cannot grow the cache without limit. */
const MAX_CACHED_MESSAGES: number = 2000;

export interface StoredMessage {
  id: string;
  /** The other party, whoever sent it. */
  peer: PubkeyHex;
  author: PubkeyHex;
  content: string;
  createdAt: number;
}

export interface Conversation {
  peer: PubkeyHex;
  lastMessage: StoredMessage;
  messageCount: number;
}

let messages: Map<string, StoredMessage> = new Map();
let loaded: boolean = false;

function announceChange(): void {
  window.dispatchEvent(new CustomEvent('dm-messages-updated'));
}

/**
 * Works out who the conversation is with.
 *
 * For a message the viewer sent, that is the `p` tag; for one they received, it
 * is the author.
 */
function resolvePeer(
  rumor: ChatRumor,
  viewerPubkey: PubkeyHex,
): PubkeyHex | null {
  if (rumor.pubkey !== viewerPubkey) {
    return rumor.pubkey;
  }

  const recipient: string | undefined = rumor.tags.find(
    (tag: string[]): boolean => tag[0] === 'p',
  )?.[1];
  return recipient ? (recipient as PubkeyHex) : null;
}

export async function loadCachedMessages(): Promise<void> {
  if (loaded) {
    return;
  }
  try {
    const cached = await getMetadata<StoredMessage[]>(CACHE_KEY);
    if (Array.isArray(cached)) {
      messages = new Map(
        cached.map((message: StoredMessage): [string, StoredMessage] => [
          message.id,
          message,
        ]),
      );
    }
  } catch (error: unknown) {
    console.warn('[dm] Failed to load cached messages:', error);
  }
  loaded = true;
}

function persist(): void {
  const ordered: StoredMessage[] = Array.from(messages.values())
    .sort(
      (a: StoredMessage, b: StoredMessage): number => b.createdAt - a.createdAt,
    )
    .slice(0, MAX_CACHED_MESSAGES);

  // Trim in memory too, so the cap actually bounds growth.
  messages = new Map(
    ordered.map((message: StoredMessage): [string, StoredMessage] => [
      message.id,
      message,
    ]),
  );
  void setMetadata(CACHE_KEY, ordered);
}

/**
 * Adds decrypted messages.
 *
 * Returns true when anything was new, so callers can avoid re-rendering for a
 * batch that turned out to be entirely known.
 */
/** Prefix for the copy added on send, before the relay echoes it back. */
const LOCAL_ID_PREFIX: string = 'local-';

/** Widened for the timestamp jitter NIP-59 applies to wraps. */
const ECHO_WINDOW_SECONDS: number = 172_800;

/**
 * Drops the optimistic copy once the real one arrives.
 *
 * A sent message is added locally so the thread updates immediately, then comes
 * back from the relay carrying its real id. Without this the two never match
 * and every message the user sends appears twice.
 */
function dropLocalEcho(rumor: ChatRumor): boolean {
  for (const [id, existing] of messages) {
    if (!id.startsWith(LOCAL_ID_PREFIX)) {
      continue;
    }
    if (
      existing.author === rumor.pubkey &&
      existing.content === rumor.content &&
      Math.abs(existing.createdAt - rumor.created_at) <= ECHO_WINDOW_SECONDS
    ) {
      messages.delete(id);
      return true;
    }
  }
  return false;
}

export function addMessages(
  rumors: ChatRumor[],
  viewerPubkey: PubkeyHex,
): boolean {
  let changed: boolean = false;

  for (const rumor of rumors) {
    if (messages.has(rumor.id)) {
      continue;
    }
    const peer: PubkeyHex | null = resolvePeer(rumor, viewerPubkey);
    if (!peer) {
      continue;
    }

    if (!rumor.id.startsWith(LOCAL_ID_PREFIX) && dropLocalEcho(rumor)) {
      changed = true;
    }

    messages.set(rumor.id, {
      id: rumor.id,
      peer,
      author: rumor.pubkey,
      content: rumor.content,
      createdAt: rumor.created_at,
    });
    changed = true;
  }

  if (changed) {
    persist();
    announceChange();
  }
  return changed;
}

/** Conversations, most recently active first. */
export function getConversations(): Conversation[] {
  const byPeer: Map<PubkeyHex, StoredMessage[]> = new Map();

  for (const message of messages.values()) {
    const bucket: StoredMessage[] = byPeer.get(message.peer) ?? [];
    bucket.push(message);
    byPeer.set(message.peer, bucket);
  }

  const conversations: Conversation[] = [];
  for (const [peer, bucket] of byPeer) {
    bucket.sort((a, b): number => b.createdAt - a.createdAt);
    const latest = bucket[0];
    if (latest) {
      conversations.push({
        peer,
        lastMessage: latest,
        messageCount: bucket.length,
      });
    }
  }

  return conversations.sort(
    (a, b): number => b.lastMessage.createdAt - a.lastMessage.createdAt,
  );
}

/** One conversation, oldest first, which is how a thread reads. */
export function getConversation(peer: PubkeyHex): StoredMessage[] {
  return Array.from(messages.values())
    .filter((message: StoredMessage): boolean => message.peer === peer)
    .sort((a, b): number => a.createdAt - b.createdAt);
}

/** Clears everything on logout, so the next account inherits no history. */
export function clearMessages(): void {
  messages = new Map();
  loaded = true;
  void setMetadata(CACHE_KEY, []);
  announceChange();
}

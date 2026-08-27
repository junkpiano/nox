/**
 * Decrypted message cache and conversation grouping.
 *
 * Unwrapping a gift wrap costs a NIP-44 decryption per message, so results are
 * cached rather than recomputed on every visit. The cache lives in the same
 * IndexedDB the rest of the app uses; these messages are already on this
 * device, and re-fetching them would mean decrypting them again anyway.
 *
 * Cached, but not in the clear: the blob is encrypted with a device-local key
 * (see `message-crypto.ts`). Nothing here is ever written anywhere else. There
 * is no export, no backup and no sync, because this client does not carry
 * private messages - the relays the user chose do.
 */

import type { PubkeyHex } from '../../../types/nostr';
import { getMetadata, setMetadata } from '../../common/db/index.js';
import { decryptJson, destroyCacheKey, encryptJson } from './message-crypto.js';
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
    const stored: unknown = await getMetadata(CACHE_KEY);

    // A bare array is a cache written before this was encrypted. Read it, then
    // rewrite it below so the plaintext copy does not survive the upgrade.
    const legacy: boolean = Array.isArray(stored);
    const cached: StoredMessage[] | null = legacy
      ? (stored as StoredMessage[])
      : await decryptJson<StoredMessage[]>(stored);

    if (Array.isArray(cached)) {
      messages = new Map(
        cached.map((message: StoredMessage): [string, StoredMessage] => [
          message.id,
          message,
        ]),
      );
    }
    if (legacy) {
      persist();
    }
  } catch (error: unknown) {
    console.warn('[dm] Failed to load cached messages:', error);
  }
  loaded = true;
}

/**
 * Writes are serialised.
 *
 * Each one rewrites the whole blob, so two in flight can finish out of order
 * and leave the older snapshot on disk.
 */
let pendingWrite: Promise<void> = Promise.resolve();

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

  pendingWrite = pendingWrite
    .then(async (): Promise<void> => {
      const payload = await encryptJson(ordered);
      if (!payload) {
        // No key means no safe way to write. Drop whatever is on disk and keep
        // this session in memory only - a cache that has to be rebuilt is a
        // better outcome than private messages stored in the clear.
        await setMetadata(CACHE_KEY, null);
        return;
      }
      await setMetadata(CACHE_KEY, payload);
    })
    .catch((error: unknown): void => {
      console.warn('[dm] Failed to persist messages:', error);
    });
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

/** True when a real message already carries this content from this author. */
function hasEquivalentMessage(rumor: ChatRumor): boolean {
  for (const [id, existing] of messages) {
    if (id.startsWith(LOCAL_ID_PREFIX)) {
      continue;
    }
    if (
      existing.author === rumor.pubkey &&
      existing.content === rumor.content &&
      Math.abs(existing.createdAt - rumor.created_at) <= ECHO_WINDOW_SECONDS
    ) {
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

    if (rumor.id.startsWith(LOCAL_ID_PREFIX)) {
      // The real copy may already have arrived from a relay, in which case the
      // placeholder is redundant rather than pending.
      if (hasEquivalentMessage(rumor)) {
        continue;
      }
    } else if (dropLocalEcho(rumor)) {
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

/**
 * Waits for queued cache writes to land.
 *
 * Persisting is fire-and-forget everywhere else, but the migration has to know
 * what is actually on disk before it rebuilds the database around it.
 */
export function flushMessageCache(): Promise<void> {
  return pendingWrite;
}

/**
 * Takes messages read out of a cache written before encryption existed.
 *
 * Seeds them and writes them back encrypted. Safe to call twice: the migration
 * does exactly that, once to replace the plaintext value and again once the
 * database has been rebuilt underneath it.
 */
export function adoptMessages(list: StoredMessage[]): void {
  messages = new Map(
    list.map((message: StoredMessage): [string, StoredMessage] => [
      message.id,
      message,
    ]),
  );
  loaded = true;
  persist();
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

  pendingWrite = pendingWrite
    .then(async (): Promise<void> => {
      await setMetadata(CACHE_KEY, null);
      // Deleting the row asks the database to forget it. Destroying the key
      // means it no longer matters whether it did.
      await destroyCacheKey();
    })
    .catch((error: unknown): void => {
      console.warn('[dm] Failed to clear messages:', error);
    });

  announceChange();
}

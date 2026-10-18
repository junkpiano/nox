import type { NostrEvent, PubkeyHex } from '../../../types/nostr';
import { getEventsByAuthor } from '../../common/db/index.js';
import { kvGet } from '../../common/kv.js';
import { publishEventToRelays } from '../../common/publish-event.js';

export interface BroadcastProgress {
  total: number;
  completed: number;
}

export interface BroadcastResult {
  total: number;
  completed: number;
  relays: number;
}

export interface BroadcastOptions {
  relays: string[];
  limit?: number;
  onProgress?: (progress: BroadcastProgress) => void;
}

export async function broadcastRecentPosts(
  options: BroadcastOptions,
): Promise<BroadcastResult> {
  // Through the shared store: localStorage on the web, the app's own
  // storage on the phone, which has no localStorage at all.
  const storedPubkey: string | null = kvGet('nostr_pubkey');
  if (!storedPubkey) {
    throw new Error('Sign-in required to broadcast.');
  }

  const relays: string[] = options.relays.filter((relay: string): boolean =>
    Boolean(relay),
  );
  if (relays.length === 0) {
    throw new Error('No relays configured.');
  }

  const limit: number = options.limit ?? 50;
  const queryLimit: number = Math.max(limit * 3, limit);
  const cachedEvents: NostrEvent[] = await getEventsByAuthor(
    storedPubkey as PubkeyHex,
    { limit: queryLimit },
  );
  const posts: NostrEvent[] = cachedEvents
    .filter((event: NostrEvent): boolean => event.kind === 1)
    .slice(0, limit)
    .sort(
      (a: NostrEvent, b: NostrEvent): number => a.created_at - b.created_at,
    );

  if (posts.length === 0) {
    throw new Error('No recent posts found in cache. Create a post first.');
  }

  const total: number = posts.length;
  let completed: number = 0;

  for (const event of posts) {
    await publishEventToRelays(event, relays);
    completed += 1;
    if (options.onProgress) {
      options.onProgress({ total, completed });
    }
  }

  return { total, completed, relays: relays.length };
}

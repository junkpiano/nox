/**
 * Things other people did that name you.
 *
 * Which events, and of what kind, is `src/common/notifications-query.ts`,
 * shared with the web; this adds the names and pictures the rows show.
 */

import type { EmojiMap } from '../../src/common/content-segments';
import {
  classifyNotification,
  fetchNotificationEvents,
  type NotificationKind,
  notificationTarget,
} from '../../src/common/notifications-query';
import { queryRelays } from '../../src/common/relay-query';
import { unwrapRepost } from '../../src/common/repost';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { customEmojiOf, pictureUrl } from './avatar';

const MAX_AUTHORS: number = 300;

export type { NotificationKind };

/** One empty map, shared: a name without emoji is the usual case. */
const EMPTY_EMOJI: EmojiMap = new Map();

export interface Notification {
  id: string;
  kind: NotificationKind;
  pubkey: PubkeyHex;
  createdAt: number;
  /** For a reaction, the symbol used; otherwise the text. */
  content: string;
  /** The event of yours this concerns, when the tags name one. */
  targetId: string | null;
  name: string;
  /** NIP-30: the pictures the author put in their own name. */
  emoji: EmojiMap;
  picture: string | null;
}

export interface NotificationResult {
  notifications: Notification[];
  stats: { events: number; relays: number; ms: number };
}

/** A field somebody else wrote is a string only if it is one. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function loadNotifications(
  viewer: PubkeyHex,
  onStage: (stage: string) => void,
): Promise<NotificationResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();

  onStage('mentions and reactions...');
  const fromOthers: NostrEvent[] = await fetchNotificationEvents(
    relays,
    viewer,
  );

  onStage('who they are...');
  const authors: string[] = Array.from(
    new Set(fromOthers.map((e: NostrEvent): string => e.pubkey)),
  ).slice(0, MAX_AUTHORS);
  const profileEvents: NostrEvent[] = await queryRelays(relays, {
    kinds: [0],
    authors,
  });

  const names: Map<
    string,
    { name: string; emoji: EmojiMap; picture: string | null }
  > = new Map();
  const at: Map<string, number> = new Map();
  for (const event of profileEvents) {
    const previous = at.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) continue;
    try {
      const meta = JSON.parse(event.content);
      names.set(event.pubkey, {
        name: str(meta.display_name) || str(meta.name),
        emoji: customEmojiOf(
          event.tags.filter((tag: string[]): boolean => tag[0] === 'emoji'),
        ),
        picture: pictureUrl(meta.picture),
      });
      at.set(event.pubkey, event.created_at);
    } catch {
      // A profile that will not parse is a profile we do not have.
    }
  }

  const notifications: Notification[] = fromOthers.map(
    (event: NostrEvent): Notification => {
      const meta = names.get(event.pubkey);
      return {
        id: event.id,
        kind: classifyNotification(event, viewer) ?? 'mention',
        pubkey: event.pubkey as PubkeyHex,
        createdAt: event.created_at,
        // A repost's content is the reposted event as JSON, not words.
        content: unwrapRepost(event).event?.content ?? '',
        targetId: notificationTarget(event),
        name: str(meta?.name) || `${event.pubkey.slice(0, 8)}...`,
        emoji: meta?.emoji ?? EMPTY_EMOJI,
        picture: meta?.picture ?? null,
      };
    },
  );

  return {
    notifications,
    stats: {
      events: fromOthers.length,
      relays: relays.length,
      ms: Date.now() - started,
    },
  };
}

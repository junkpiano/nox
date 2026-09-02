/**
 * Things other people did that name you.
 *
 * Reactions, reposts and replies all carry a `p` tag pointing at whoever they
 * concern, so one filter finds all three. Your own events are dropped: a
 * reply to your own post is a conversation you are already having, not news.
 */

import { filterMutedEvents } from '../../src/common/mute-state';
import { openRelaySubscription } from '../../src/common/relay-socket';
import { unwrapRepost } from '../../src/common/repost';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';

const NOTIFICATION_KINDS: number[] = [1, 6, 7];
const LIMIT: number = 200;
const TIMEOUT_MS: number = 9000;
const MAX_AUTHORS: number = 300;

export type NotificationKind = 'reaction' | 'repost' | 'reply';

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
  picture: string | null;
}

export interface NotificationResult {
  notifications: Notification[];
  stats: { events: number; relays: number; ms: number };
}

function queryRelays(
  relays: string[],
  filter: Record<string, unknown>,
): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve) => {
    const byId: Map<string, NostrEvent> = new Map();
    const stops: Array<() => void> = [];
    let done: number = 0;
    let settled: boolean = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Already gone.
        }
      }
      resolve(Array.from(byId.values()));
    };

    const timer = setTimeout(finish, TIMEOUT_MS);
    const oneDone = (): void => {
      done += 1;
      if (done >= relays.length) finish();
    };

    for (const relayUrl of relays) {
      openRelaySubscription(relayUrl, filter, {
        onEvent: (event: NostrEvent): void => {
          if (!byId.has(event.id)) byId.set(event.id, event);
        },
        onEose: oneDone,
        onClosed: oneDone,
      })
        .then((stop: () => void): void => {
          stops.push(stop);
        })
        .catch(oneDone);
    }

    if (relays.length === 0) finish();
  });
}

/**
 * Which of your events this concerns.
 *
 * NIP-10 puts the event being replied to in an `e` tag, and a reaction points
 * at what it reacts to the same way. The last `e` tag is the immediate parent
 * under both the marked and the legacy positional conventions.
 */
function targetOf(event: NostrEvent): string | null {
  const eTags = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  const reply = eTags.find((tag: string[]): boolean => tag[3] === 'reply');
  if (reply?.[1]) return reply[1];
  const last = eTags[eTags.length - 1];
  return last?.[1] ?? null;
}

function classify(event: NostrEvent): NotificationKind {
  if (event.kind === 7) return 'reaction';
  if (event.kind === 6) return 'repost';
  return 'reply';
}

export async function loadNotifications(
  viewer: PubkeyHex,
  onStage: (stage: string) => void,
): Promise<NotificationResult> {
  const started: number = Date.now();
  const relays: string[] = getRelays();

  onStage('mentions and reactions...');
  const events: NostrEvent[] = await queryRelays(relays, {
    kinds: NOTIFICATION_KINDS,
    '#p': [viewer],
    limit: LIMIT,
  });

  // Two things are dropped here. Your own events name you too - a reply in
  // your own thread carries your `p` tag - and that is a conversation you are
  // already in rather than news. And anyone muted: being told that somebody
  // you muted reacted to you is the notification working against the mute.
  const fromOthers: NostrEvent[] = filterMutedEvents(
    events.filter((event: NostrEvent): boolean => event.pubkey !== viewer),
  );

  onStage('who they are...');
  const authors: string[] = Array.from(
    new Set(fromOthers.map((e: NostrEvent): string => e.pubkey)),
  ).slice(0, MAX_AUTHORS);
  const profileEvents: NostrEvent[] = await queryRelays(relays, {
    kinds: [0],
    authors,
  });

  const names: Map<string, { name: string; picture: string | null }> =
    new Map();
  const at: Map<string, number> = new Map();
  for (const event of profileEvents) {
    const previous = at.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) continue;
    try {
      const meta = JSON.parse(event.content);
      names.set(event.pubkey, {
        name: meta.display_name || meta.name || '',
        picture: typeof meta.picture === 'string' ? meta.picture : null,
      });
      at.set(event.pubkey, event.created_at);
    } catch {
      // A profile that will not parse is a profile we do not have.
    }
  }

  const notifications: Notification[] = fromOthers
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at)
    .map((event: NostrEvent): Notification => {
      const meta = names.get(event.pubkey);
      return {
        id: event.id,
        kind: classify(event),
        pubkey: event.pubkey as PubkeyHex,
        createdAt: event.created_at,
        // A repost's content is the reposted event as JSON, not words.
        content: unwrapRepost(event).event?.content ?? '',
        targetId: targetOf(event),
        name: meta?.name || `${event.pubkey.slice(0, 8)}...`,
        picture: meta?.picture ?? null,
      };
    });

  return {
    notifications,
    stats: {
      events: fromOthers.length,
      relays: relays.length,
      ms: Date.now() - started,
    },
  };
}

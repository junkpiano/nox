/**
 * What other people did that names you: the fetching and sorting half of
 * notifications, shared by the web and the phone. Drawing the rows is each
 * front end's.
 *
 * Reactions, reposts, replies and mentions all carry a `p` tag pointing at
 * whoever they concern, so one filter finds them all.
 */
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { isMachineContent } from './machine-content.js';
import { filterMutedEvents } from './mute-state.js';
import { queryRelays } from './relay-query.js';
import { checkRepostNotes, unwrapRepost } from './repost.js';

export type NotificationKind = 'reaction' | 'repost' | 'reply' | 'mention';

export const NOTIFICATION_LIMIT: number = 100;

/**
 * What kind of notification `event` is for `viewer`, or null when it is not
 * one. A note counts only if it names the viewer itself - a `p` tag on a
 * reaction or repost names the author of what was reacted to, which is the
 * viewer by construction of the query - and is a reply when it answers an
 * event, a mention when it does not.
 */
export function classifyNotification(
  event: NostrEvent,
  viewer: PubkeyHex,
): NotificationKind | null {
  if (event.kind === 7) return 'reaction';
  if (event.kind === 6) return 'repost';
  if (event.kind !== 1) return null;
  const namesViewer: boolean = event.tags.some(
    (tag: string[]): boolean => tag[0] === 'p' && tag[1] === viewer,
  );
  if (!namesViewer) return null;
  return event.tags.some((tag: string[]): boolean => tag[0] === 'e')
    ? 'reply'
    : 'mention';
}

/**
 * Which event this concerns: the one replied or reacted to.
 *
 * NIP-10 marks it `reply`; under the legacy positional convention it is the
 * last `e` tag. The first `e` tag is the thread's root, which is not it.
 */
export function notificationTarget(event: NostrEvent): string | null {
  const eTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
  const reply: string[] | undefined = eTags.find(
    (tag: string[]): boolean => tag[3] === 'reply',
  );
  return reply?.[1] ?? eTags[eTags.length - 1]?.[1] ?? null;
}

/**
 * The newest notifications for `viewer`, newest first.
 *
 * Three things are dropped. The viewer's own events name them too - a reply in
 * their own thread carries their `p` tag - and that is a conversation they are
 * already in rather than news. Anyone muted: being told that somebody you
 * muted reacted to you is the notification working against the mute. And
 * machine output that happens to name you, which the timelines hide too.
 */
export async function fetchNotificationEvents(
  relays: string[],
  viewer: PubkeyHex,
  limit: number = NOTIFICATION_LIMIT,
): Promise<NostrEvent[]> {
  const events: NostrEvent[] = await queryRelays(relays, {
    kinds: [1, 6, 7],
    '#p': [viewer],
    limit,
  });
  const fromOthers: NostrEvent[] = filterMutedEvents(
    events.filter(
      (event: NostrEvent): boolean =>
        event.pubkey !== viewer && classifyNotification(event, viewer) !== null,
    ),
  );
  await checkRepostNotes(fromOthers);
  return fromOthers
    .filter((event: NostrEvent): boolean => {
      const shown: NostrEvent | null = unwrapRepost(event).event;
      return !isMachineContent(shown?.content ?? event.content);
    })
    .sort((a: NostrEvent, b: NostrEvent): number => b.created_at - a.created_at)
    .slice(0, limit);
}

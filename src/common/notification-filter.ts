/**
 * Notifications from the people you follow, and nobody else.
 *
 * Replies and reactions are addressed to you by whoever sends them, and
 * whoever sends them includes the accounts that answer every note on the
 * network. Narrowing the list to the people on your follow list is the
 * one filter that needs no judgement about content: it is your own list.
 *
 * The judgement here is about the list itself. A follow list nobody could
 * fetch is not an empty one - a person who follows nobody should see an
 * empty page that says so, and a person whose relays were down should see
 * everything, with a line saying the filter could not be applied. Both
 * apps draw from this; the switch is theirs.
 */

import { verifyEvent } from 'nostr-tools';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { kvGet, kvSet } from './kv.js';
import {
  NoRelayAnsweredError,
  queryRelaysDetailed,
  type SubscriptionOpener,
} from './relay-query.js';

export type NotificationScope = 'all' | 'following';

/** Where the choice is kept, on this device. */
const SCOPE_KEY: string = 'notifications_scope';

export function readNotificationScope(): NotificationScope {
  return kvGet(SCOPE_KEY) === 'following' ? 'following' : 'all';
}

export function saveNotificationScope(scope: NotificationScope): void {
  kvSet(SCOPE_KEY, scope);
}

/** The notifications whose authors are on the list. Pure; order kept. */
export function fromFollowedAuthors(
  events: NostrEvent[],
  following: ReadonlySet<PubkeyHex>,
): NostrEvent[] {
  return events.filter((event: NostrEvent): boolean =>
    following.has(event.pubkey as PubkeyHex),
  );
}

function genuine(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

/**
 * The people the viewer follows, judged from what the relays sent.
 *
 * Only the viewer's own, genuinely signed kind 3 counts, and the newest
 * one wins; a relay may answer an `authors` filter with anything. No kind
 * 3 at all is an empty set - the person follows nobody, which is an
 * answer, and a different one from "nobody answered".
 */
export function collectFollowSet(
  viewer: PubkeyHex,
  events: NostrEvent[],
): Set<PubkeyHex> {
  let newest: NostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== 3 || event.pubkey !== viewer) continue;
    if (!genuine(event)) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  const following: Set<PubkeyHex> = new Set();
  if (newest) {
    for (const tag of newest.tags) {
      if (tag[0] === 'p' && tag[1]) following.add(tag[1] as PubkeyHex);
    }
  }
  return following;
}

/**
 * Asks the relays for the viewer's follow list.
 *
 * Throws `NoRelayAnsweredError` when no relay answered: an empty set
 * learned from a dead connection would hide every notification behind a
 * filter nobody chose.
 */
export async function fetchFollowSet(
  viewer: PubkeyHex,
  relays: string[],
  open?: SubscriptionOpener,
): Promise<Set<PubkeyHex>> {
  if (relays.length === 0) {
    throw new NoRelayAnsweredError(relays);
  }
  const { events, answered } = await queryRelaysDetailed(
    relays,
    { kinds: [3], authors: [viewer], limit: 3 },
    open,
  );
  if (answered === 0) {
    throw new NoRelayAnsweredError(relays);
  }
  return collectFollowSet(viewer, events);
}

/** What a screen shows once it has asked. */
export type ScopedNotifications =
  | { scope: 'all'; events: NostrEvent[] }
  | {
      scope: 'following';
      events: NostrEvent[];
      /** How many people the list names; zero is its own empty state. */
      followCount: number;
    }
  | {
      /** The filter was asked for but could not be applied: everything is shown. */
      scope: 'following-unavailable';
      events: NostrEvent[];
    };

/**
 * Applies the chosen scope, fetching the follow list when it is needed.
 *
 * One function for both apps, so "could not fetch" and "follows nobody"
 * come out the same way on each and the screens only have to say them.
 */
export async function scopeNotifications(
  scope: NotificationScope,
  viewer: PubkeyHex,
  events: NostrEvent[],
  relays: string[],
  open?: SubscriptionOpener,
): Promise<ScopedNotifications> {
  if (scope === 'all') {
    return { scope: 'all', events };
  }
  let following: Set<PubkeyHex>;
  try {
    following = await fetchFollowSet(viewer, relays, open);
  } catch {
    return { scope: 'following-unavailable', events };
  }
  return {
    scope: 'following',
    events: fromFollowedAuthors(events, following),
    followCount: following.size,
  };
}

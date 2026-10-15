/**
 * Whether an event belongs on screen: one rule for every timeline, on the web
 * and on the phone.
 *
 * Muting either side of a repost - the author, or whoever passed it on - is a
 * reason not to see it. Machine output (a note whose whole body is a JSON
 * object) is judged on what would be shown. A repost with no readable copy is
 * judged when its target is fetched, as the card does: its own content is
 * that copy's JSON, which would read as machine output.
 */
import type { NostrEvent } from '../../types/nostr';
import { withoutDeleted } from './deleted-events.js';
import { isMachineContent } from './machine-content.js';
import { filterMutedEvents } from './mute-state.js';
import { unwrapRepost } from './repost.js';

export function isShowable(event: NostrEvent): boolean {
  const copy: NostrEvent | null = unwrapRepost(event).event;
  const judged: NostrEvent[] = copy && copy !== event ? [event, copy] : [event];
  if (filterMutedEvents(judged).length !== judged.length) return false;
  return !(copy && isMachineContent(copy.content));
}

/** The events to show, given the ids whose authors withdrew them. */
export function showableEvents(
  events: NostrEvent[],
  deleted: Set<string>,
): NostrEvent[] {
  return withoutDeleted(events, deleted).filter(isShowable);
}

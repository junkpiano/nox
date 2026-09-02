/**
 * Which posts the author has asked to withdraw.
 *
 * NIP-09 is a request: relays may keep the event, and this client can still
 * fetch it. Honouring it is the client's job, and a timeline that does not is
 * showing people something they asked to take back.
 *
 * Only the author's own request counts. A kind:5 is an ordinary event that
 * anybody can publish naming anybody's post - checking the `e` tag alone would
 * let a stranger delete your posts from everyone's timeline by asking.
 *
 * The matching is pure and the fetching is not, so they are separate: the
 * caller decides how to ask the relays, and this decides what the answer
 * means.
 */

import type { NostrEvent } from '../../types/nostr';
import { queryRelays } from './relay-query.js';

export const DELETION_KIND: number = 5;

/**
 * The ids named by a deletion request from the same person who wrote them.
 *
 * `events` is what is about to be shown; `deletions` is whatever kind:5 came
 * back for them. Anything not in `events` is ignored, so a relay answering
 * generously costs nothing.
 */
export function collectDeletedIds(
  events: NostrEvent[],
  deletions: NostrEvent[],
): Set<string> {
  const authorOf: Map<string, string> = new Map();
  for (const event of events) {
    authorOf.set(event.id, event.pubkey);
  }

  const deleted: Set<string> = new Set();
  for (const request of deletions) {
    if (request.kind !== DELETION_KIND) {
      continue;
    }
    for (const tag of request.tags) {
      if (tag[0] !== 'e' || !tag[1]) {
        continue;
      }
      // Same person, or it is somebody asking to delete a post that is not
      // theirs - which is a request this client has no reason to honour.
      if (authorOf.get(tag[1]) === request.pubkey) {
        deleted.add(tag[1]);
      }
    }
  }
  return deleted;
}

/** Drops the withdrawn posts, keeping the order of the rest. */
export function withoutDeleted<T extends { id: string }>(
  events: T[],
  deleted: Set<string>,
): T[] {
  if (deleted.size === 0) {
    return events;
  }
  return events.filter((event: T): boolean => !deleted.has(event.id));
}

/**
 * Which of these the author has asked to withdraw, asked of the relays.
 *
 * One query for the whole batch rather than one per card. Relays index `e`
 * tags, so this is the filter they are built to answer; the ids are chunked
 * because a filter naming a thousand of them is a filter some relays refuse.
 */
export async function fetchDeletedIds(
  relays: string[],
  events: NostrEvent[],
): Promise<Set<string>> {
  const ids: string[] = events.map((event: NostrEvent): string => event.id);
  if (ids.length === 0) {
    return new Set();
  }

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }

  const results = await Promise.allSettled(
    chunks.map((chunk: string[]) =>
      queryRelays(relays, { kinds: [DELETION_KIND], '#e': chunk }),
    ),
  );

  const deletions: NostrEvent[] = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  return collectDeletedIds(events, deletions);
}

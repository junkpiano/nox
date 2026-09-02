/**
 * Which posts the author has asked to withdraw.
 *
 * NIP-09 is a request: relays may keep the event, and this client can still
 * fetch it. Honouring it is the client's job, and a timeline that does not is
 * showing people something they asked to take back.
 *
 * Only the author's own request counts, and only a request the author
 * actually signed. A kind:5 is an ordinary event that anybody can publish
 * naming anybody's post - checking the `e` tag alone would let a stranger
 * delete your posts from everyone's timeline by asking. And a relay is a
 * stranger too: one that answers with an unsigned kind:5 carrying your
 * pubkey would do the same, so the signature is checked here rather than
 * trusted to have been checked on the way in.
 *
 * The matching is pure and the fetching is not, so they are separate: the
 * caller decides how to ask the relays, and this decides what the answer
 * means.
 */

import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';
import {
  NoRelayAnsweredError,
  queryRelaysDetailed,
  type RelayQueryResult,
} from './relay-query.js';

export const DELETION_KIND: number = 5;

/** Whether this request was signed by the key it claims. */
function isGenuine(request: NostrEvent): boolean {
  try {
    return verifyEvent(request);
  } catch {
    return false;
  }
}

/**
 * The ids named by a deletion request from the same person who wrote them.
 *
 * `events` is what is about to be shown; `deletions` is whatever kind:5 came
 * back for them. Anything not in `events` is ignored, so a relay answering
 * generously costs nothing. A request whose signature does not verify is
 * ignored too, whatever pubkey it carries.
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
    // Names something on screen at all? Only then is the signature worth
    // the cost of checking.
    const names: string[] = request.tags
      .filter((tag: string[]): boolean => tag[0] === 'e' && !!tag[1])
      .map((tag: string[]): string => tag[1] as string)
      .filter((id: string): boolean => authorOf.get(id) === request.pubkey);
    if (names.length === 0 || !isGenuine(request)) {
      continue;
    }
    for (const id of names) {
      deleted.add(id);
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

/** Asks the relays; the real one over the sockets, a test's not. */
export type DeletionQuery = (
  relays: string[],
  filter: Record<string, unknown>,
) => Promise<RelayQueryResult>;

/**
 * Which of these the author has asked to withdraw, asked of the relays.
 *
 * One query for the whole batch rather than one per card. Relays index `e`
 * tags, so this is the filter they are built to answer; the ids are chunked
 * because a filter naming a thousand of them is a filter some relays refuse.
 *
 * Throws when no relay answered for some chunk. Silence is not "nothing was
 * withdrawn", and a caller that remembers answers must not remember this
 * one.
 */
export async function fetchDeletedIds(
  relays: string[],
  events: NostrEvent[],
  query: DeletionQuery = queryRelaysDetailed,
): Promise<Set<string>> {
  const ids: string[] = events.map((event: NostrEvent): string => event.id);
  if (ids.length === 0) {
    return new Set();
  }

  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }

  const results: RelayQueryResult[] = await Promise.all(
    chunks.map((chunk: string[]) =>
      query(relays, { kinds: [DELETION_KIND], '#e': chunk }),
    ),
  );
  if (
    results.some((result: RelayQueryResult): boolean => result.answered === 0)
  ) {
    throw new NoRelayAnsweredError(relays);
  }

  const deletions: NostrEvent[] = results.flatMap(
    (result: RelayQueryResult): NostrEvent[] => result.events,
  );
  return collectDeletedIds(events, deletions);
}

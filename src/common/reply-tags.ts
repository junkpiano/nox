/**
 * The tags that make a reply part of a conversation.
 *
 * NIP-10 is how every other client reconstructs a thread, and getting it wrong
 * does not fail visibly: the reply is published, it renders, and it is simply
 * detached from the discussion it belongs to. Nobody upstream is notified and
 * nobody's client can place it.
 *
 * Two things must be carried:
 *
 * **The root.** A reply to a reply needs `["e", <root>, "", "root"]` as well as
 * `["e", <parent>, "", "reply"]`. Emitting only the parent - which is what this
 * app did before this module existed - loses the thread from the second level
 * down.
 *
 * **Everyone upstream.** The `p` tags are who gets told. Naming only the
 * immediate author means the person who started the thread never hears the
 * answer to it.
 *
 * The marked scheme is written and both schemes are read, because plenty of
 * events in the wild still use the positional one: `e` tags in order, root
 * first, parent last, with no markers at all.
 */

import type { NostrEvent } from '../../types/nostr';

/** An `e` tag: ['e', id, relay?, marker?]. */
function eTags(event: NostrEvent): string[][] {
  return event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && Boolean(tag[1]),
  );
}

/**
 * The root of the thread the given event belongs to.
 *
 * An event with no `e` tags is itself a root. Otherwise the marked `root` tag
 * wins; failing that, the positional convention puts the root first.
 */
export function threadRoot(event: NostrEvent): string {
  const tags: string[][] = eTags(event);
  if (tags.length === 0) {
    return event.id;
  }

  const marked = tags.find((tag: string[]): boolean => tag[3] === 'root');
  if (marked?.[1]) {
    return marked[1];
  }

  // Positional: the first `e` tag is the root. Only trusted when nothing is
  // marked, since a marked event that happens to list `reply` first would
  // otherwise be misread.
  const anyMarker = tags.some(
    (tag: string[]): boolean => tag[3] === 'root' || tag[3] === 'reply',
  );
  if (!anyMarker) {
    return tags[0]?.[1] ?? event.id;
  }

  // Marked, but with no root marker: a direct reply to a root, whose `reply`
  // tag therefore names the root.
  const reply = tags.find((tag: string[]): boolean => tag[3] === 'reply');
  return reply?.[1] ?? event.id;
}

/**
 * Tags for a reply to `parent`.
 *
 * `p` tags accumulate: the parent's author, plus everyone the parent was
 * already addressing, deduplicated and with the author first so the most
 * relevant name leads.
 */
export function replyTags(parent: NostrEvent): string[][] {
  const root: string = threadRoot(parent);
  const tags: string[][] = [];

  if (root === parent.id) {
    // Replying to the start of a thread: one `e` tag, marked as the root.
    tags.push(['e', parent.id, '', 'root']);
  } else {
    tags.push(['e', root, '', 'root']);
    tags.push(['e', parent.id, '', 'reply']);
  }

  const people: string[] = [parent.pubkey];
  for (const tag of parent.tags) {
    if (tag[0] === 'p' && tag[1] && !people.includes(tag[1])) {
      people.push(tag[1]);
    }
  }
  for (const pubkey of people) {
    tags.push(['p', pubkey]);
  }

  return tags;
}

/** Tags for a repost of `target`. NIP-18: the event, and its author. */
export function repostTags(target: NostrEvent): string[][] {
  return [
    ['e', target.id],
    ['p', target.pubkey],
  ];
}

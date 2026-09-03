/**
 * NIP-10: which note a reply is answering.
 *
 * A reply's `e` tags name the thread's root and the note being answered.
 * The marked form says which is which; the older positional form does
 * not, and there the convention is that the last `e` tag is the parent.
 * A note with no `e` tag at all is not a reply.
 */

import type { NostrEvent } from '../../types/nostr';

export interface ReplyTarget {
  id: string;
  /** The relay hint on the tag, when the author left one. */
  relays: string[];
}

function target(tag: string[]): ReplyTarget {
  const hint: string | undefined = tag[2];
  return {
    id: tag[1] as string,
    relays: hint && /^wss?:\/\//i.test(hint) ? [hint] : [],
  };
}

/** The note this one answers, or null when it answers nothing. */
export function replyParentOf(event: NostrEvent): ReplyTarget | null {
  const eTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && !!tag[1],
  );
  if (eTags.length === 0) return null;
  const marked = (marker: string): string[] | undefined =>
    eTags.find((tag: string[]): boolean => tag[3] === marker);
  const reply: string[] | undefined = marked('reply');
  if (reply) return target(reply);
  const root: string[] | undefined = marked('root');
  if (root) return target(root);
  // A mention is a quote, not an answer.
  const positional: string[][] = eTags.filter(
    (tag: string[]): boolean => tag[3] !== 'mention',
  );
  const last: string[] | undefined = positional[positional.length - 1];
  return last ? target(last) : null;
}

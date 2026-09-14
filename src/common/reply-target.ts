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

/**
 * The NIP-10 marker on an `e` tag, or '' when it carries none.
 *
 * The fourth place is not always a marker. A NIP-22 comment puts the
 * parent's author there, and a hex key read as a marker made every comment
 * look marked with something unknown: the web thread, which falls back to
 * unmarked tags, found no parent and drew a reply to a comment as a reply
 * to the post.
 */
export function eTagMarker(tag: string[]): '' | 'root' | 'reply' | 'mention' {
  const marker: string = (tag[3] ?? '').trim().toLowerCase();
  return marker === 'root' || marker === 'reply' || marker === 'mention'
    ? marker
    : '';
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

/**
 * The conversation an event belongs to, when it names one.
 *
 * A NIP-22 comment names it in an `E` tag. A NIP-10 reply names it in the
 * `e` tag marked root or, in the older positional form, the first `e` tag.
 * Null for an event that answers nothing, or one whose root is not said.
 */
export function threadRootOf(event: NostrEvent): string | null {
  if (event.kind === 1111) {
    const scope: string[] | undefined = event.tags.find(
      (tag: string[]): boolean => tag[0] === 'E' && !!tag[1],
    );
    return scope?.[1] ?? null;
  }
  const eTags: string[][] = event.tags.filter(
    (tag: string[]): boolean => tag[0] === 'e' && !!tag[1],
  );
  const root: string[] | undefined = eTags.find(
    (tag: string[]): boolean => eTagMarker(tag) === 'root',
  );
  if (root?.[1]) return root[1];
  const unmarked: string[] | undefined = eTags.find(
    (tag: string[]): boolean => eTagMarker(tag) === '',
  );
  return unmarked?.[1] ?? null;
}

/**
 * The events among `candidates` that descend from `ancestorId`.
 *
 * Each is followed up through its parents, as far as the candidates reach.
 * One that arrives at `ancestorId` is kept; one that reaches the top, leaves
 * the candidates, or loops is not. What is learned on the way is remembered,
 * so a long conversation is walked once rather than once per reply.
 */
export function descendantsOf(
  ancestorId: string,
  candidates: NostrEvent[],
): NostrEvent[] {
  const byId: Map<string, NostrEvent> = new Map(
    candidates.map((event: NostrEvent): [string, NostrEvent] => [
      event.id,
      event,
    ]),
  );
  const known: Map<string, boolean> = new Map();

  const leadsHome = (start: NostrEvent): boolean => {
    const path: string[] = [];
    const visited: Set<string> = new Set();
    let current: NostrEvent | undefined = start;
    let answer: boolean = false;
    while (current) {
      const remembered: boolean | undefined = known.get(current.id);
      if (remembered !== undefined) {
        answer = remembered;
        break;
      }
      if (visited.has(current.id)) break;
      visited.add(current.id);
      path.push(current.id);
      const parent: string | undefined = replyParentOf(current)?.id;
      if (!parent) break;
      if (parent === ancestorId) {
        answer = true;
        break;
      }
      current = byId.get(parent);
    }
    for (const id of path) known.set(id, answer);
    return answer;
  };

  return candidates.filter(
    (event: NostrEvent): boolean => event.id !== ancestorId && leadsHome(event),
  );
}

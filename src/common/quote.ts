/**
 * Quoting a post (NIP-18): a new post of one's own words that points at
 * another. The words end with a `nostr:` reference to the quoted post, and
 * a `q` tag names it, so every client can draw it as a card under the words
 * and count it as a quote rather than a reply. A `p` tag tells its author.
 *
 * Shared with the phone: no DOM here.
 */

import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '../../types/nostr';

/** The reference a quote ends with: an nevent, with its author and kind. */
export function quoteReference(event: NostrEvent): string {
  return `nostr:${nip19.neventEncode({
    id: event.id,
    author: event.pubkey,
    kind: event.kind,
  })}`;
}

/** The NIP-18 `q` tag for a quoted event, and a `p` so its author is told. */
export function quoteTags(event: NostrEvent): string[][] {
  return [
    ['q', event.id, '', event.pubkey],
    ['p', event.pubkey],
  ];
}

/** A quote's content: the words, then whatever else, then the reference. */
export function quoteContent(parts: string[], quoted: NostrEvent): string {
  return [...parts, quoteReference(quoted)]
    .map((part: string): string => part.trim())
    .filter((part: string): boolean => part.length > 0)
    .join('\n\n');
}

/**
 * What a timeline asks the relays for, on every front end.
 *
 * Notes and reposts (NIP-18 kind 6, and kind 16 for anything other than a
 * note). Other kinds that carry text - chat messages, channel posts, long-form
 * - have screens of their own or none, and drawn as a plain card in a timeline
 * they read as notes they are not.
 */
import { PAGE_LIMIT } from './timeline-paging.js';

export const FEED_KINDS: number[] = [1, 6, 16];

/** Posts asked for at a time: a first screen sooner, and scrolling for more. */
export const FEED_LIMIT: number = PAGE_LIMIT;

/** Notes carrying one hashtag: the `#t` tag NIP-12 indexes, lowercased. */
export function hashtagFeedFilter(tag: string): Record<string, unknown> {
  return { kinds: [1], '#t': [tag.toLowerCase()] };
}

/** One person's notes and reposts. */
export function userFeedFilter(pubkey: string): Record<string, unknown> {
  return { kinds: FEED_KINDS, authors: [pubkey] };
}

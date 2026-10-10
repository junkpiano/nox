/**
 * The custom emoji someone has collected: NIP-30 pictures, listed by NIP-51.
 *
 * Kind 10030 is the list. It names emoji directly in `emoji` tags, and
 * whole sets by address in `a` tags (`30030:<pubkey>:<d>`), each set a
 * kind 30030 event of `emoji` tags. Other clients build these lists; this
 * reads them, so the picture someone reacts with is one they chose.
 *
 * Shared with the phone: no DOM here.
 */

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import { readEmojiTags } from './custom-emoji.js';
import { newestOf, queryEveryRelay, queryRelays } from './relay-query.js';

export interface CustomEmoji {
  /** As the list wrote it; `:shortcode:` in a reaction uses this. */
  shortcode: string;
  url: string;
}

const EMOJI_LIST_KIND: number = 10030;
const EMOJI_SET_KIND: number = 30030;
/** A list naming more sets than this is asked about in parts. */
const SET_CHUNK: number = 50;

/** The emoji tags of an event that pass the NIP-30 checks, in order. */
function emojiOf(event: NostrEvent): CustomEmoji[] {
  const out: CustomEmoji[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'emoji' || !tag[1]) continue;
    // One tag at a time through the shared reader: it holds the shortcode
    // to the NIP's alphabet and the URL to something an <img> may load.
    const url: string | undefined = readEmojiTags([tag]).get(
      tag[1].toLowerCase(),
    );
    if (url) out.push({ shortcode: tag[1], url });
  }
  return out;
}

/** `30030:<pubkey>:<d>` addresses named by the list. */
function setAddresses(list: NostrEvent): Array<{ pubkey: string; d: string }> {
  const out: Array<{ pubkey: string; d: string }> = [];
  for (const tag of list.tags) {
    if (tag[0] !== 'a' || !tag[1]) continue;
    const [kind, pubkey, ...rest] = tag[1].split(':');
    const d: string = rest.join(':');
    // `30030:<pubkey>:` names the set whose d is empty; without the colon it
    // names nothing.
    if (
      rest.length > 0 &&
      kind === String(EMOJI_SET_KIND) &&
      pubkey &&
      /^[0-9a-f]{64}$/.test(pubkey)
    ) {
      out.push({ pubkey, d });
    }
  }
  return out;
}

/**
 * Someone's custom emoji: those their list names directly first, then each
 * set's, in the list's order. A shortcode appears once, as first met.
 */
export async function fetchEmojiList(
  viewer: PubkeyHex,
  relays: string[],
): Promise<CustomEmoji[]> {
  // Every relay's word: the newest list may sit on the slowest one.
  const list: NostrEvent | null = newestOf(
    await queryEveryRelay(relays, {
      kinds: [EMOJI_LIST_KIND],
      authors: [viewer],
      limit: 1,
    }),
  );
  if (!list) return [];

  const addresses = setAddresses(list);
  const sets: NostrEvent[] = [];
  for (let index = 0; index < addresses.length; index += SET_CHUNK) {
    const chunk = addresses.slice(index, index + SET_CHUNK);
    sets.push(
      ...(await queryRelays(relays, {
        kinds: [EMOJI_SET_KIND],
        authors: Array.from(new Set(chunk.map((a) => a.pubkey))),
        '#d': Array.from(new Set(chunk.map((a) => a.d))),
      })),
    );
  }
  // A set is replaceable: the newest copy of each address, in list order.
  const newestSet = (pubkey: string, d: string): NostrEvent | null =>
    newestOf(
      sets.filter(
        (event: NostrEvent): boolean =>
          event.pubkey === pubkey &&
          (event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '') === d,
      ),
    );

  const seen: Set<string> = new Set();
  const out: CustomEmoji[] = [];
  const add = (emoji: CustomEmoji[]): void => {
    for (const item of emoji) {
      const key: string = item.shortcode.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  };
  add(emojiOf(list));
  for (const { pubkey, d } of addresses) {
    const set: NostrEvent | null = newestSet(pubkey, d);
    if (set) add(emojiOf(set));
  }
  return out;
}

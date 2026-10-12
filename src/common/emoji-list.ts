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
import { publishAndCount } from './publish-event.js';
import {
  NoRelayAnsweredError,
  newestOf,
  queryEveryRelay,
  queryRelays,
  queryRelaysDetailed,
} from './relay-query.js';
import { signWithSession } from './signer.js';

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

/**
 * Adds one emoji to someone's own list, and publishes the list.
 *
 * The list is replaceable: what is published is the whole of it, so it
 * starts from the newest copy every relay holds, and is not written at all
 * when no relay answered - a list rebuilt from nothing would delete every
 * emoji and set the person already had. Everything already in it, the
 * `content` with any private entries included, is carried over unchanged.
 */
export async function addToEmojiList(
  viewer: PubkeyHex,
  relays: string[],
  emoji: CustomEmoji,
): Promise<'added' | 'already'> {
  const result = await queryRelaysDetailed(
    relays,
    { kinds: [EMOJI_LIST_KIND], authors: [viewer], limit: 1 },
    undefined,
    { everyRelay: true },
  );
  // Every relay, not most: the newest copy may sit on the one that did not
  // answer, and the copy written here would replace it.
  if (result.answered < new Set(relays).size) {
    throw new NoRelayAnsweredError(relays);
  }
  // Someone else's reaction is where this emoji came from; it is held to
  // the same rules as one read from a list.
  const url: string | undefined = readEmojiTags([
    ['emoji', emoji.shortcode, emoji.url],
  ]).get(emoji.shortcode.toLowerCase());
  if (!url) throw new Error('That emoji cannot be added.');
  const list: NostrEvent | null = newestOf(result.events);
  const tags: string[][] = list ? list.tags.map((tag) => [...tag]) : [];
  const shortcode: string = emoji.shortcode.toLowerCase();
  if (
    tags.some(
      (tag: string[]): boolean =>
        tag[0] === 'emoji' && tag[1]?.toLowerCase() === shortcode,
    )
  ) {
    return 'already';
  }
  tags.push(['emoji', emoji.shortcode, url]);
  const signed: NostrEvent = await signWithSession({
    kind: EMOJI_LIST_KIND,
    // Later than the copy it replaces, even on a clock that runs behind.
    created_at: Math.max(
      Math.floor(Date.now() / 1000),
      (list?.created_at ?? 0) + 1,
    ),
    tags,
    content: list?.content ?? '',
  });
  if ((await publishAndCount(signed, relays)) === 0) {
    throw new Error('No relay accepted the list.');
  }
  return 'added';
}

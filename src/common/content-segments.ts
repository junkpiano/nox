/**
 * Splitting a post into the parts that are not text.
 *
 * A note's content is a single string with references buried in it: links,
 * `nostr:npub…` mentions, `nostr:nevent…` quotes. The web app finds them while
 * building HTML, which is 2,300 lines of DOM work the phone cannot use - so
 * what is shared is the finding, and each build renders the result its own way.
 *
 * Everything here is pure and takes no view on presentation. A segment says
 * what a run of characters *is*; whether that becomes an anchor, a Pressable
 * or a preview card is the caller's business.
 *
 * Only `nostr:`-prefixed references are recognised, which is what the web app
 * does. A bare npub in prose is usually somebody quoting a key, not linking to
 * one, and turning every mention of a key into a link makes a post about keys
 * unreadable.
 */

import { nip19 } from 'nostr-tools';
import type { PubkeyHex } from '../../types/nostr';
import { classifyMediaUrl, type MediaKind } from './media-type.js';

export type ContentSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'url';
      text: string;
      url: string;
      /** Set when the extension names a picture or a video. */
      media: MediaKind | null;
    }
  /** A person. `pubkey` is null when the identifier will not decode. */
  | { kind: 'mention'; text: string; pubkey: PubkeyHex | null }
  /**
   * A quoted note. `eventId` is null when the identifier will not decode.
   * `relays` are the hints an `nevent` carries - where the author says the
   * note lives, which for a note that lives nowhere else is the only way
   * to find it. A bare `note` has none.
   */
  | { kind: 'event'; text: string; eventId: string | null; relays: string[] }
  /** A hashtag. `tag` is the word without the `#`, lowercased, as NIP-12 `t`. */
  | { kind: 'hashtag'; text: string; tag: string };

/**
 * One pass, so the parts cannot overlap or be found twice.
 *
 * Ordered by how specific each pattern is: a `nostr:` reference is matched
 * before a bare URL, because `nostr:` is a scheme and a naive URL pattern that
 * ran first would have to know to leave it alone.
 */
const PATTERN =
  /nostr:(npub1[0-9a-z]+|nprofile1[0-9a-z]+|note1[0-9a-z]+|nevent1[0-9a-z]+)|(https?:\/\/[^\s<]+)|(?:^|[^\p{L}\p{N}_/])#([\p{L}\p{N}_]+)/giu;

/** Trailing punctuation is sentence, not URL. */
function trimUrlTail(url: string): string {
  let end: number = url.length;
  while (end > 0) {
    const character: string = url[end - 1] ?? '';
    if (!'.,;:!?)]}"\''.includes(character)) {
      break;
    }
    // A closing bracket is only punctuation when nothing opened it inside the
    // URL - "…/wiki/Foo_(bar)" is a real link and losing its tail breaks it.
    if (character === ')' && url.slice(0, end).includes('(')) {
      break;
    }
    if (character === ']' && url.slice(0, end).includes('[')) {
      break;
    }
    end -= 1;
  }
  return url.slice(0, end);
}

function decodeMention(identifier: string): PubkeyHex | null {
  try {
    const decoded = nip19.decode(identifier.toLowerCase());
    if (decoded.type === 'npub') {
      return decoded.data as PubkeyHex;
    }
    if (decoded.type === 'nprofile') {
      return (decoded.data as { pubkey: string }).pubkey as PubkeyHex;
    }
  } catch {
    // Somebody's typo, or an identifier from a spec this build predates.
  }
  return null;
}

function decodeEvent(
  identifier: string,
): { id: string; relays: string[] } | null {
  try {
    const decoded = nip19.decode(identifier.toLowerCase());
    if (decoded.type === 'note') {
      return { id: decoded.data as string, relays: [] };
    }
    if (decoded.type === 'nevent') {
      const data = decoded.data as { id: string; relays?: string[] };
      // Only relay URLs. A hint is a string the author chose, and it is
      // about to be connected to.
      const relays: string[] = (data.relays ?? []).filter(
        (relay: string): boolean => /^wss?:\/\//i.test(relay),
      );
      return { id: data.id, relays };
    }
  } catch {
    // As above.
  }
  return null;
}

/**
 * Splits `content` into segments, in order, covering every character.
 *
 * Concatenating every segment's `text` returns the original string. That is
 * worth relying on: it means a renderer cannot silently drop part of what
 * somebody wrote by failing to handle a kind.
 */
export function parseContentSegments(content: string): ContentSegment[] {
  if (!content) {
    return [];
  }

  const segments: ContentSegment[] = [];
  let cursor: number = 0;

  PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = PATTERN.exec(content);
  while (match !== null) {
    const [whole, reference, rawUrl, hashtag] = match;
    const start: number = match.index;

    if (reference !== undefined) {
      if (start > cursor) {
        segments.push({ kind: 'text', text: content.slice(cursor, start) });
      }
      const lower: string = reference.toLowerCase();
      if (lower.startsWith('npub1') || lower.startsWith('nprofile1')) {
        segments.push({
          kind: 'mention',
          text: whole,
          pubkey: decodeMention(reference),
        });
      } else {
        const quoted = decodeEvent(reference);
        segments.push({
          kind: 'event',
          text: whole,
          eventId: quoted?.id ?? null,
          relays: quoted?.relays ?? [],
        });
      }
      cursor = start + whole.length;
    } else if (rawUrl !== undefined) {
      const url: string = trimUrlTail(rawUrl);
      if (url.length > 0) {
        if (start > cursor) {
          segments.push({ kind: 'text', text: content.slice(cursor, start) });
        }
        segments.push({
          kind: 'url',
          text: url,
          url,
          media: classifyMediaUrl(url),
        });
        cursor = start + url.length;
        // The trimmed tail is text, and the next search resumes from it.
        PATTERN.lastIndex = cursor;
      }
    }

    if (hashtag !== undefined) {
      // The pattern consumes the character before the `#` so a URL fragment
      // or a word ending in one is not a tag. That character is text.
      const hashStart: number = start + whole.indexOf('#');
      // A tag needs a letter in it. "#695" in a Wordle score is a number
      // somebody wrote, and linking it sends the reader to an empty search.
      // A rejected one leaves the cursor alone, so its characters are picked
      // up as text by whatever comes next.
      if (/\p{L}/u.test(hashtag)) {
        if (hashStart > cursor) {
          segments.push({
            kind: 'text',
            text: content.slice(cursor, hashStart),
          });
        }
        segments.push({
          kind: 'hashtag',
          text: `#${hashtag}`,
          tag: hashtag.toLowerCase(),
        });
        cursor = hashStart + hashtag.length + 1;
      }
      PATTERN.lastIndex = hashStart + hashtag.length + 1;
    }

    match = PATTERN.exec(content);
  }

  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }

  return segments;
}

export interface PartitionedContent {
  /** Everything that reads as prose, in order, media links removed. */
  segments: ContentSegment[];
  /** The pictures and videos, in the order they appeared. */
  media: Array<{ url: string; kind: MediaKind }>;
  /**
   * Quoted notes, deduplicated by id, each with the relay hints it came
   * with.
   *
   * Pulled out of the prose the way media is: a quote is a card under the
   * post, not thirty characters of bech32 in the middle of a sentence. An
   * undecodable reference stays in the text, where it renders as itself.
   */
  quotes: Array<{ id: string; relays: string[] }>;
}

/**
 * Separates the media from the sentence.
 *
 * A picture belongs under the post, not in the middle of a line as forty
 * characters of URL - which is what a phone was showing, because a `<Text>`
 * cannot hold an image and nothing had pulled the two apart. Whitespace left
 * behind by a removed link is collapsed so the text does not end in a gap
 * where a URL used to be.
 */
export function partitionContent(content: string): PartitionedContent {
  const all: ContentSegment[] = parseContentSegments(content);
  const media: Array<{ url: string; kind: MediaKind }> = [];
  const quotes: Array<{ id: string; relays: string[] }> = [];
  const segments: ContentSegment[] = [];

  for (const segment of all) {
    if (segment.kind === 'url' && segment.media) {
      media.push({ url: segment.url, kind: segment.media });
      continue;
    }
    if (segment.kind === 'event' && segment.eventId) {
      const id: string = segment.eventId;
      const known = quotes.find((quote) => quote.id === id);
      if (known) {
        // The same note twice, perhaps once as `note` and once as `nevent`:
        // one card, with every hint either mention gave.
        for (const relay of segment.relays) {
          if (!known.relays.includes(relay)) known.relays.push(relay);
        }
      } else {
        quotes.push({ id, relays: [...segment.relays] });
      }
      continue;
    }
    segments.push(segment);
  }

  // Trailing and doubled whitespace, once the links are gone.
  const text: string = segments
    .map((segment: ContentSegment): string => segment.text)
    .join('');
  if (text.trim().length === 0) {
    return { segments: [], media, quotes };
  }

  return { segments, media, quotes };
}

/** A short, safe label for a mention or a quote. */
export function shortIdentifier(identifier: string): string {
  const bare: string = identifier.replace(/^nostr:/i, '');
  return bare.length > 14 ? `${bare.slice(0, 12)}…` : bare;
}

/**
 * What a mute list contains, and how to change part of it without losing the
 * rest.
 *
 * kind:10000 is replaceable: publishing one replaces the whole list on every
 * relay that accepts it. So the same hazard applies here as to a follow list -
 * a client that rebuilds the entries from only the part it understands does
 * not fail, it publishes, and the parts it did not understand are gone.
 *
 * NIP-51 allows `p` (people), `word`, `t` (hashtags) and `e` (events). This
 * app acts on people and words. It does not act on hashtags or events, and it
 * is precisely those that must survive a round trip untouched, because nothing
 * here would notice them disappearing.
 */

import type { PubkeyHex } from '../../../types/nostr';

export interface MuteEntries {
  pubkeys: PubkeyHex[];
  /** Lowercased on the way in: matching is case-insensitive. */
  words: string[];
  /**
   * Every other entry, kept verbatim.
   *
   * Hashtag and event mutes set by another client live here. They are written
   * back exactly as they arrived rather than being understood, because the
   * alternative is deleting somebody's settings to tidy up a list.
   */
  otherTags: string[][];
}

export const EMPTY_MUTE_ENTRIES: MuteEntries = {
  pubkeys: [],
  words: [],
  otherTags: [],
};

/** Splits a tag list into the parts this app acts on, and everything else. */
export function readMuteTags(tags: unknown): MuteEntries {
  if (!Array.isArray(tags)) {
    return { pubkeys: [], words: [], otherTags: [] };
  }

  const pubkeys: PubkeyHex[] = [];
  const words: string[] = [];
  const otherTags: string[][] = [];

  for (const tag of tags) {
    if (!Array.isArray(tag) || typeof tag[0] !== 'string') {
      continue;
    }
    if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1]) {
      pubkeys.push(tag[1] as PubkeyHex);
      continue;
    }
    if (tag[0] === 'word' && typeof tag[1] === 'string' && tag[1].trim()) {
      words.push(tag[1].trim().toLowerCase());
      continue;
    }
    otherTags.push(tag as string[]);
  }

  return { pubkeys, words, otherTags };
}

/** Rebuilds the tag list, putting back everything that was read. */
export function writeMuteTags(entries: MuteEntries): string[][] {
  return [
    ...entries.pubkeys.map((pubkey: PubkeyHex): string[] => ['p', pubkey]),
    ...entries.words.map((word: string): string[] => ['word', word]),
    ...entries.otherTags,
  ];
}

/** Merges two readings of the same list - public tags and decrypted content. */
export function mergeMuteEntries(a: MuteEntries, b: MuteEntries): MuteEntries {
  const pubkeys: PubkeyHex[] = Array.from(
    new Set([...a.pubkeys, ...b.pubkeys]),
  );
  const words: string[] = Array.from(new Set([...a.words, ...b.words]));
  const seen: Set<string> = new Set();
  const otherTags: string[][] = [];
  for (const tag of [...a.otherTags, ...b.otherTags]) {
    const key: string = JSON.stringify(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    otherTags.push(tag);
  }
  return { pubkeys, words, otherTags };
}

/**
 * Whether a post's text contains one of the muted words.
 *
 * Matching is on whole words, case-insensitively. A substring match would hide
 * "class" for somebody who muted "ass", which is the failure that makes people
 * stop trusting the feature and turn it off.
 *
 * The comparison is deliberately plain: no stemming, no fuzzy matching, no
 * guessing at intent. The person chose these words and should be able to
 * predict exactly what disappears.
 */
export function matchesMutedWord(content: string, words: string[]): boolean {
  if (words.length === 0 || !content) {
    return false;
  }
  const haystack: string = content.toLowerCase();
  return words.some((word: string): boolean => {
    const index: number = haystack.indexOf(word);
    if (index === -1) {
      return false;
    }
    // A word boundary on each side, where "boundary" means anything that is
    // not a letter or a digit. Good enough for the languages that separate
    // words with spaces; for those that do not, the plain substring is the
    // honest behaviour rather than a wrong guess.
    const before: string = haystack[index - 1] ?? ' ';
    const after: string = haystack[index + word.length] ?? ' ';
    const isWordChar = (character: string): boolean =>
      /[\p{L}\p{N}]/u.test(character);
    return !isWordChar(before) && !isWordChar(after);
  });
}

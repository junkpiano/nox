/**
 * NIP-30: the pictures a post uses as emoji.
 *
 * An `emoji` tag pairs a shortcode with an image URL, and `:shortcode:` in
 * the content means that image. Both halves are the author's: the shortcode
 * is held to the letters, digits and underscores the NIP describes, and the
 * URL to something an <img> could be pointed at - the same rule as an
 * avatar, because it is the same question.
 */

import { type ImagePolicy, loadableImageUrl } from './avatar.js';

/** Exactly the NIP's alphabet. A colon or a space in a shortcode is not one. */
const SHORTCODE: RegExp = /^[a-z0-9_]+$/i;

/** Where the shortcodes are in a run of text. */
export const SHORTCODE_IN_TEXT: RegExp = /:([a-z0-9_]+):/gi;

/**
 * The usable emoji on an event, by lowercased shortcode.
 *
 * Later tags win over earlier ones with the same shortcode, which is what a
 * reader replacing in order would see too.
 */
export function readEmojiTags(
  tags: string[][],
  policy: ImagePolicy = { secureOnly: false },
): Map<string, string> {
  const emoji: Map<string, string> = new Map();
  for (const tag of tags) {
    if (tag[0] !== 'emoji') continue;
    const shortcode: string | undefined = tag[1];
    if (!shortcode || !SHORTCODE.test(shortcode)) continue;
    const url: string | null = loadableImageUrl(tag[2], policy);
    if (!url) continue;
    emoji.set(shortcode.toLowerCase(), url);
  }
  return emoji;
}

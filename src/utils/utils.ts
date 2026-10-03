import emojiDictionary from 'emoji-dictionary';
import type { NostrProfile, Npub, PubkeyHex } from '../../types/nostr';
import { avatarUrlFor } from '../common/avatar.js';
import { pageImagePolicy } from '../common/avatar-dom.js';

// The fetch lives with the parser; re-exported for the callers that always
// found it here.
export { fetchOGP } from '../common/ogp-fetch.js';

export function shortenNpub(npub: Npub): string {
  return `${npub.slice(0, 12)}...`;
}

export function getAvatarURL(
  pubkey: PubkeyHex,
  profile: NostrProfile | null,
): string {
  return avatarUrlFor(pubkey, profile, pageImagePolicy());
}

/**
 * What to call someone: the name they chose, or a short form of their key.
 *
 * The NIP-05 address used to come first, so a card said "jordan@nostr.land"
 * where the person had written "Jordan The Nostr Miner". An address is
 * where someone can be reached, not what they are called; it is shown
 * beside the name, dimmer, by `getNip05Label`.
 */
export function getDisplayName(
  npub: Npub,
  profile: NostrProfile | null,
): string {
  const chosen: string | undefined =
    profile?.display_name?.trim() || profile?.name?.trim();
  return chosen || profile?.nip05?.trim() || shortenNpub(npub);
}

/** The address beside a name, or nothing when there is none. */
export function getNip05Label(profile: NostrProfile | null): string {
  return profile?.nip05?.trim() ?? '';
}

export function replaceEmojiShortcodes(content: string): string {
  return content.replace(
    /:([a-z0-9_+-]+):/gi,
    (match: string, code: string): string => {
      const emoji: string | undefined = emojiDictionary.getUnicode(code);
      return emoji || match;
    },
  );
}

/**
 * Checks if a URL is a Twitter/X post URL
 * @param url - The URL to check
 * @returns true if the URL is a Twitter/X post, false otherwise
 */
export function isTwitterURL(url: string): boolean {
  try {
    const urlObj: URL = new URL(url);
    const hostname: string = urlObj.hostname.toLowerCase();
    const isTwitterDomain: boolean =
      hostname === 'twitter.com' ||
      hostname === 'www.twitter.com' ||
      hostname === 'x.com' ||
      hostname === 'www.x.com';
    // Check if it's a status URL (contains /status/)
    const isStatusURL: boolean = urlObj.pathname.includes('/status/');
    return isTwitterDomain && isStatusURL;
  } catch {
    return false;
  }
}

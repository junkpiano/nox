import emojiDictionary from 'emoji-dictionary';
import type { NostrProfile, Npub, PubkeyHex } from '../../types/nostr';
import { avatarUrlFor } from '../common/avatar.js';
import { pageImagePolicy } from '../common/avatar-dom.js';
import { crossOriginFetch } from '../common/native-http.js';

// The fetch lives with the parser; re-exported for the callers that always
// found it here.
export { fetchOGP } from '../common/ogp-fetch.js';

const twitterEmbedCache: Map<string, Promise<string | null>> = new Map();

export function shortenNpub(npub: Npub): string {
  return `${npub.slice(0, 12)}...`;
}

export function getAvatarURL(
  pubkey: PubkeyHex,
  profile: NostrProfile | null,
): string {
  return avatarUrlFor(pubkey, profile, pageImagePolicy());
}

export function getDisplayName(
  npub: Npub,
  profile: NostrProfile | null,
): string {
  return profile?.nip05 || profile?.name || shortenNpub(npub);
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

/**
 * Fetches Twitter oEmbed data for embedded tweets
 * @param url - The Twitter/X post URL
 * @returns Promise resolving to oEmbed HTML string, or null if fetch fails
 */
export async function fetchTwitterEmbed(url: string): Promise<string | null> {
  const cached: Promise<string | null> | undefined = twitterEmbedCache.get(url);
  if (cached) {
    return cached;
  }

  const request: Promise<string | null> = (async (): Promise<string | null> => {
    try {
      const encodedURL: string = encodeURIComponent(url);
      const oembedURL: string = `https://publish.twitter.com/oembed?url=${encodedURL}&theme=light&dnt=true`;

      const response: Response = await crossOriginFetch(oembedURL);

      if (!response.ok) {
        console.error(
          `Failed to fetch Twitter embed for ${url}: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const data: { html: string } = await response.json();
      return data.html;
    } catch (error: unknown) {
      console.error(`Error fetching Twitter embed for ${url}:`, error);
      return null;
    }
  })();

  twitterEmbedCache.set(url, request);
  return request;
}

/**
 * Loads Twitter's widgets.js script if not already loaded
 */
export function loadTwitterWidgets(): void {
  if (!(window as any).twttr) {
    const script: HTMLScriptElement = document.createElement('script');
    script.src = 'https://platform.twitter.com/widgets.js';
    script.async = true;
    script.charset = 'utf-8';
    document.head.appendChild(script);
  } else {
    // If script is already loaded, refresh widgets
    (window as any).twttr.widgets.load();
  }
}

import emojiDictionary from 'emoji-dictionary';
import type {
  NostrProfile,
  Npub,
  OGPMetadata,
  OGPResponse,
  PubkeyHex,
} from '../../types/nostr';
import { avatarUrlFor } from '../common/avatar.js';
import { pageImagePolicy } from '../common/avatar-dom.js';
import { crossOriginFetch, isNativeRuntime } from '../common/native-http.js';
import { parseOgpDocument } from '../common/ogp-parse.js';

const ogpCache: Map<string, Promise<OGPResponse | null>> = new Map();
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

/**
 * Fetches OGP metadata through the CORS proxy worker.
 *
 * Used on the web, where the WebView cannot read cross-origin HTML directly.
 */
async function fetchOGPViaProxy(url: string): Promise<OGPResponse | null> {
  const encodedURL: string = encodeURIComponent(url);
  const apiURL: string = `https://nostr-proxy-worker.junkpiano.workers.dev/api/ogp?url=${encodedURL}`;

  const response: Response = await fetch(apiURL);

  if (!response.ok) {
    console.error(
      `Failed to fetch OGP for ${url}: ${response.status} ${response.statusText}`,
    );
    return null;
  }

  const data: OGPResponse = await response.json();
  return data;
}

/**
 * Fetches OGP metadata straight from the origin and parses it locally.
 *
 * Only viable in the native shell, where requests are issued from Rust and are
 * not subject to CORS. Skipping the proxy removes a hop and a dependency.
 */
async function fetchOGPDirect(url: string): Promise<OGPResponse | null> {
  const response: Response = await crossOriginFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });

  if (!response.ok) {
    console.error(
      `Failed to fetch OGP for ${url}: ${response.status} ${response.statusText}`,
    );
    return null;
  }

  // Checked before reading the body so non-HTML targets (images, video,
  // archives) are not downloaded just to be discarded.
  const contentType: string = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('html')) {
    return null;
  }

  const html: string = await response.text();
  const data: OGPMetadata = parseOgpDocument(html, response.url || url);

  return Object.keys(data).length > 0 ? { url, data } : null;
}

/**
 * Fetches Open Graph Protocol (OGP) metadata for a given URL
 * @param url - The URL to fetch OGP information for
 * @returns Promise resolving to OGP response object, or null if fetch fails
 */
export async function fetchOGP(url: string): Promise<OGPResponse | null> {
  const cached: Promise<OGPResponse | null> | undefined = ogpCache.get(url);
  if (cached) {
    return cached;
  }

  const request: Promise<OGPResponse | null> =
    (async (): Promise<OGPResponse | null> => {
      try {
        return isNativeRuntime()
          ? await fetchOGPDirect(url)
          : await fetchOGPViaProxy(url);
      } catch (error: unknown) {
        console.error(`Error fetching OGP for ${url}:`, error);
        return null;
      }
    })();

  ogpCache.set(url, request);
  return request;
}

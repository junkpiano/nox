/**
 * Which picture to show for a person, and what to do when it will not load.
 *
 * A profile's picture is a URL its owner chose, and some of them cannot be
 * shown: an `.onion` address needs Tor, an `http:` picture on an `https:`
 * page is mixed content the browser refuses, `javascript:` is not a
 * picture at all. Asking the browser for those anyway costs a failed load
 * per card - and, when the failure handler swapped in a second picture that
 * also failed, the handler fired again for that one, and the avatar
 * flickered for as long as the page was open.
 *
 * So the decision is made before the request: a picture that cannot load
 * is never asked for, the stand-in is the same one the app uses when a
 * profile has no picture, and the failure handler runs once.
 */

import type { NostrProfile, PubkeyHex } from '../../types/nostr';

/** The picture a person gets when theirs cannot be shown. */
export function fallbackAvatarUrl(pubkey: PubkeyHex | string): string {
  return `https://robohash.org/${encodeURIComponent(pubkey)}.png`;
}

export interface ImagePolicy {
  /**
   * The page is served over HTTPS, so a plain `http:` picture would be
   * blocked as mixed content. On the web this is read off the page; the
   * phone has no such rule.
   */
  secureOnly: boolean;
}

/**
 * The URL if a picture at it could be loaded, or null.
 *
 * `https:` always; `http:` unless the page is secure; `data:image/` and
 * `blob:` because those are already here. An `.onion` host is refused
 * outright - it needs Tor, which a browser tab and a phone do not have.
 */
export function loadableImageUrl(
  url: string | null | undefined,
  policy: ImagePolicy,
): string | null {
  if (!url) return null;
  const text: string = url.trim();
  if (!text) return null;
  const lower: string = text.toLowerCase();
  if (lower.startsWith('data:image/')) return text;
  if (lower.startsWith('blob:')) return text;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.protocol === 'http:' && policy.secureOnly) return null;
  const host: string = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'onion' || host.endsWith('.onion')) return null;
  return parsed.toString();
}

/** The person's own picture if it can be shown, else the stand-in. */
export function avatarUrlFor(
  pubkey: PubkeyHex | string,
  profile: NostrProfile | null,
  policy: ImagePolicy,
): string {
  return (
    loadableImageUrl(profile?.picture, policy) ?? fallbackAvatarUrl(pubkey)
  );
}

/**
 * The `onerror` attribute for an avatar `<img>` written into HTML.
 *
 * Clears itself before swapping in the stand-in, so a stand-in that also
 * fails to load fails once and stays failed rather than reloading forever.
 * The stand-in URL contains only the pubkey (hex) and fixed text, so it is
 * safe inside a double-quoted attribute.
 */
export function avatarErrorAttribute(pubkey: PubkeyHex | string): string {
  return `this.onerror=null;this.src='${fallbackAvatarUrl(pubkey)}';`;
}

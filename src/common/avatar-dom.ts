/**
 * The web's side of `avatar.ts`: the page's own policy, and the failure
 * handler on an `<img>` the code built itself.
 */

import type { NostrProfile, PubkeyHex } from '../../types/nostr';
import {
  avatarUrlFor,
  fallbackAvatarUrl,
  type ImagePolicy,
  loadableImageUrl,
} from './avatar.js';

/** What this page can load: no plain `http:` pictures on an `https:` page. */
export function pageImagePolicy(): ImagePolicy {
  return {
    secureOnly:
      typeof location !== 'undefined' && location.protocol === 'https:',
  };
}

/** A picture URL this page could load, or null. */
export function loadableOnThisPage(
  url: string | null | undefined,
): string | null {
  return loadableImageUrl(url, pageImagePolicy());
}

/**
 * Points an `<img>` at a person's picture, with the stand-in ready.
 *
 * The failure handler removes itself before swapping, so a stand-in that
 * also fails does not fire it again - which was the flicker.
 */
export function setAvatar(
  img: HTMLImageElement,
  pubkey: PubkeyHex | string,
  profile: NostrProfile | null,
): void {
  const fallback: string = fallbackAvatarUrl(pubkey);
  img.onerror = (): void => {
    img.onerror = null;
    if (img.src !== fallback) img.src = fallback;
  };
  img.src = avatarUrlFor(pubkey, profile, pageImagePolicy());
}

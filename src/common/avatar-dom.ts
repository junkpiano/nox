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

/** The parts of an `<img>` the failure handler touches. */
interface FailedImage {
  tagName: string;
  src: string;
  dataset: Record<string, string | undefined>;
  parentElement: { classList: { add(name: string): void } } | null;
  remove(): void;
}

/**
 * Handles a failed `<img>` load anywhere in the page, in place of inline
 * `onerror` attributes, which the Content-Security-Policy forbids.
 *
 * - `data-fallback-src`: load that URL instead, once.
 * - `data-error-parent-class`: add that class to the parent and drop the image.
 */
export function handleImageError(event: { target: unknown }): void {
  const img = event.target as FailedImage | null;
  if (!img || img.tagName !== 'IMG') return;
  const fallback: string | undefined = img.dataset.fallbackSrc;
  if (fallback) {
    delete img.dataset.fallbackSrc;
    // Already the stand-in: it failed too, and asking again would fail again.
    if (img.src !== fallback) img.src = fallback;
    return;
  }
  const parentClass: string | undefined = img.dataset.errorParentClass;
  if (parentClass) {
    img.parentElement?.classList.add(parentClass);
    img.remove();
  }
}

/** Listens for every failed image, in the capture phase: `error` does not bubble. */
export function installImageFallbacks(): void {
  document.addEventListener('error', handleImageError, true);
}

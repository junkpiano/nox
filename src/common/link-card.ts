/**
 * What a link card says, decided once for both apps.
 *
 * A page's Open Graph tags are a bag of strings some site chose; a card is
 * a title, a line of description, a picture and the name of the place. The
 * choosing - which tag to prefer, what counts as a picture, what to call a
 * site that gave no name - is here, so the web's card and the phone's card
 * say the same thing about the same page.
 */

import type { OGPResponse } from '../../types/nostr';
import type { ContentSegment } from './content-segments.js';

export interface LinkCard {
  url: string;
  title: string;
  description: string;
  /** An http(s) picture, or none. */
  image: string | null;
  /** The site's own name, or its host. */
  site: string;
}

/** An absolute http(s) URL as a string, or null for anything else. */
function httpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url: URL = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** One line, the way a card shows it. */
function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The card for a page, or null when there is nothing worth a card.
 *
 * A page that gave neither a title nor a description is not described, so
 * a bare host in a box would be all the card could say; the plain link in
 * the text already says that.
 */
export function describeLink(ogp: OGPResponse): LinkCard | null {
  const url: string | null = httpUrl(ogp.url);
  if (!url) return null;
  const data = ogp.data;
  const title: string = oneLine(data['og:title'] || data.title);
  const description: string = oneLine(
    data['og:description'] || data.description,
  );
  if (!title && !description) return null;
  const host: string = hostOf(url);
  return {
    url,
    title: title || host,
    description,
    image: httpUrl(data['og:image']) ?? httpUrl(data['twitter:image']),
    site: oneLine(data['og:site_name']) || host,
  };
}

/**
 * The links in a post that deserve a card: web pages, not pictures or
 * videos (those are shown themselves) and not more than a couple - a post
 * that is a list of links is a list, and a stack of cards would bury it.
 */
export function cardWorthyUrls(
  segments: ContentSegment[],
  limit: number = 2,
): string[] {
  const urls: string[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'url' || segment.media !== null) continue;
    const url: string | null = httpUrl(segment.url);
    if (!url || urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

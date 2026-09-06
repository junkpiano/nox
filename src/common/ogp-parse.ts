/**
 * Reading a page's Open Graph tags out of its HTML.
 *
 * Written without a DOM on purpose. The web used `DOMParser`, which the
 * phone does not have - Hermes has no document - and a link card is not
 * worth a parser dependency. The tags this wants are `<meta>` elements in
 * the head and, failing those, `<title>`; a scan for those two is enough,
 * and it runs the same on the web, in the Tauri shell and on the phone.
 *
 * Produces the shape the proxy worker returns, so every path hands the card
 * an identical object.
 */

import type { OGPMetadata } from '../../types/nostr';

/**
 * Meta keys whose values are URLs and therefore need resolving against the
 * page URL when a document uses relative paths.
 */
const URL_VALUED_KEYS: ReadonlySet<string> = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'og:url',
  'twitter:image',
  'twitter:image:src',
]);

/** Beyond this the head is long over; the rest is the page. */
const SCAN_LIMIT: number = 512 * 1024;

const META_TAG: RegExp = /<meta\b[^>]*>/gi;
const ATTRIBUTE: RegExp =
  /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const TITLE_TAG: RegExp = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

function resolveAgainst(value: string, pageUrl: string): string {
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return value;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** The few entities that turn up in a title or a description. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole: string, body: string): string => {
      const lower: string = body.toLowerCase();
      if (lower.startsWith('#x')) {
        const code: number = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (lower.startsWith('#')) {
        const code: number = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[lower] ?? whole;
    },
  );
}

/** The attributes of one tag, lower-cased names, entities decoded. */
function attributesOf(tag: string): Map<string, string> {
  const attributes: Map<string, string> = new Map();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name: string = (match[1] ?? '').toLowerCase();
    const value: string = match[2] ?? match[3] ?? match[4] ?? '';
    if (name && !attributes.has(name)) {
      attributes.set(name, decodeEntities(value));
    }
  }
  return attributes;
}

/**
 * Extracts OGP/Twitter card metadata from a raw HTML document.
 *
 * @param html - Raw HTML of the page
 * @param pageUrl - URL the HTML was fetched from, used to resolve relative URLs
 * @returns Collected metadata; empty when the document carries no usable tags
 */
export function parseOgpDocument(html: string, pageUrl: string): OGPMetadata {
  const metadata: OGPMetadata = {};
  const source: string =
    html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html;

  for (const match of source.matchAll(META_TAG)) {
    const attributes: Map<string, string> = attributesOf(match[0]);
    const key: string = (
      attributes.get('property') ??
      attributes.get('name') ??
      ''
    ).trim();
    const content: string = (attributes.get('content') ?? '').trim();
    if (!key || !content) {
      continue;
    }
    // First occurrence wins, matching how scrapers typically read duplicates.
    if (metadata[key] !== undefined) {
      continue;
    }
    metadata[key] = URL_VALUED_KEYS.has(key)
      ? resolveAgainst(content, pageUrl)
      : content;
  }

  if (metadata.title === undefined) {
    const title: string = decodeEntities(TITLE_TAG.exec(source)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (title) {
      metadata.title = title;
    }
  }

  return metadata;
}

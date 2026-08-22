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

function resolveAgainst(value: string, pageUrl: string): string {
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return value;
  }
}

/**
 * Extracts OGP/Twitter card metadata from a raw HTML document.
 *
 * Produces the same shape the proxy worker returns, so both the web and native
 * code paths hand `renderOGPCard()` an identical object.
 *
 * @param html - Raw HTML of the page
 * @param pageUrl - URL the HTML was fetched from, used to resolve relative URLs
 * @returns Collected metadata; empty when the document carries no usable tags
 */
export function parseOgpDocument(html: string, pageUrl: string): OGPMetadata {
  const metadata: OGPMetadata = {};

  const doc: Document = new DOMParser().parseFromString(html, 'text/html');

  const metaTags: NodeListOf<HTMLMetaElement> =
    doc.querySelectorAll<HTMLMetaElement>('meta');
  for (const meta of metaTags) {
    const key: string | null =
      meta.getAttribute('property') ?? meta.getAttribute('name');
    const content: string | null = meta.getAttribute('content');
    if (!key || content === null) {
      continue;
    }

    const trimmedKey: string = key.trim();
    const trimmedContent: string = content.trim();
    if (!trimmedKey || !trimmedContent) {
      continue;
    }

    // First occurrence wins, matching how scrapers typically read duplicates.
    if (metadata[trimmedKey] !== undefined) {
      continue;
    }

    metadata[trimmedKey] = URL_VALUED_KEYS.has(trimmedKey)
      ? resolveAgainst(trimmedContent, pageUrl)
      : trimmedContent;
  }

  if (metadata.title === undefined) {
    const titleText: string =
      doc.querySelector('title')?.textContent?.trim() ?? '';
    if (titleText) {
      metadata.title = titleText;
    }
  }

  return metadata;
}

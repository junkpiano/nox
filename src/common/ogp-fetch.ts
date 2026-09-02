/**
 * Reading a page's Open Graph tags, whichever way the page can be reached.
 *
 * A browser tab cannot read another site's HTML - CORS - so it asks the
 * proxy worker, which answers with the tags as JSON. The Tauri shell and the
 * phone read the page themselves and parse it with the shared parser; the
 * result is the same shape either way. One promise per URL is kept for the
 * session, so a link that appears in ten posts is fetched once.
 *
 * Kept apart from utils.ts, which pulls in the emoji dictionary and the
 * rest of the web's kitchen drawer; the phone wants only this.
 */

import type { OGPMetadata, OGPResponse } from '../../types/nostr';
import {
  crossOriginFetch,
  hasCrossOriginFetch,
  isNativeRuntime,
} from './native-http.js';
import { parseOgpDocument } from './ogp-parse.js';

const ogpCache: Map<string, Promise<OGPResponse | null>> = new Map();

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
        // The Tauri shell and the phone both read the page themselves; only
        // a browser tab needs the proxy to get past CORS.
        return isNativeRuntime() || hasCrossOriginFetch()
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

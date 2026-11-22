/**
 * Reading a page's Open Graph tags, whichever way the page can be reached.
 *
 * A browser tab cannot read another site's HTML - CORS - so it asks the
 * proxy worker, which answers with the tags as JSON. So do the phone and
 * the desktop app, for a different reason: see fetchOGPViaProxy. One promise
 * per URL is kept for the session, so a link that appears in ten posts is
 * fetched once.
 *
 * Kept apart from utils.ts, which pulls in the emoji dictionary and the
 * rest of the web's kitchen drawer; the phone wants only this.
 */

import type { OGPResponse } from '../../types/nostr';
import { crossOriginFetch, isNativeRuntime } from './native-http.js';
import type { PublicFetch } from './public-fetch.js';

const ogpCache: Map<string, Promise<OGPResponse | null>> = new Map();

export const OGP_PROXY: string =
  'https://nostr-proxy-worker.junkpiano.workers.dev/api/ogp';

/** How long the proxy gets to answer. */
export const PROXY_TIMEOUT_MS: number = 10_000;

/** How the proxy is asked: the browser's fetch, or the app's own client. */
export type ProxyFetch = PublicFetch;

/**
 * Fetches OGP metadata through the proxy worker.
 *
 * Used on the web, where a tab cannot read another site's HTML, and in the
 * apps, where they could but must not: the URL came out of somebody else's
 * post, and a request made from the reader's own device reaches whatever is
 * on the reader's own network. Checking the name is not enough - a public
 * name can resolve to a private address, and a runtime that follows
 * redirects itself has already made the request by the time the landing
 * address can be looked at. The proxy makes the request from somewhere
 * that is nobody's home network, refuses private targets, and answers
 * with the tags as a small JSON document.
 */
export async function fetchOGPViaProxy(
  url: string,
  fetchFn: ProxyFetch = (target, init) => fetch(target, init),
): Promise<OGPResponse | null> {
  const apiURL: string = `${OGP_PROXY}?url=${encodeURIComponent(url)}`;
  const abort: AbortController = new AbortController();
  const deadline = setTimeout((): void => abort.abort(), PROXY_TIMEOUT_MS);
  try {
    const response: Response = await fetchFn(apiURL, { signal: abort.signal });
    if (!response.ok) {
      console.error(
        `Failed to fetch OGP for ${url}: ${response.status} ${response.statusText}`,
      );
      return null;
    }
    const data: OGPResponse = await response.json();
    return data && typeof data === 'object' && data.data ? data : null;
  } finally {
    clearTimeout(deadline);
  }
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
        // The desktop app asks through its own HTTP client: its webview's
        // origin is not one the proxy answers CORS for.
        return isNativeRuntime()
          ? await fetchOGPViaProxy(url, crossOriginFetch)
          : await fetchOGPViaProxy(url);
      } catch (error: unknown) {
        console.error(`Error fetching OGP for ${url}:`, error);
        return null;
      }
    })();

  ogpCache.set(url, request);
  return request;
}

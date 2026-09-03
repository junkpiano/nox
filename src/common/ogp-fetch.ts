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
import { isPublicWebUrl } from './url-safety.js';

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

/** How long a page gets to answer, including any redirects. */
export const DIRECT_FETCH_TIMEOUT_MS: number = 10_000;
/** How much of a page is read. The head is long over by then. */
export const DIRECT_FETCH_MAX_BYTES: number = 256 * 1024;
/** How many redirects are followed, each checked like the first request. */
const MAX_REDIRECTS: number = 3;

export type DirectFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetches OGP metadata straight from the origin and parses it locally.
 *
 * Only where requests are not subject to CORS: the Tauri shell and the
 * phone. The URL came out of somebody else's post, and the request is made
 * by the reader's own device on the reader's own network, so:
 *
 * - only a public web address is asked for, and every redirect is held to
 *   the same rule before it is followed, so a link cannot steer the phone
 *   at its router or a metadata service;
 * - the whole thing is given a deadline, so a page that never answers does
 *   not hold a request open for as long as the post is on screen;
 * - the body is read up to a limit and no further, so a page of any size
 *   costs the phone the same.
 *
 * A runtime that will not do manual redirects follows them itself; the
 * final address is then checked instead, and a body from a private address
 * is thrown away unread.
 */
export async function fetchOGPDirect(
  url: string,
  fetchFn: DirectFetch = crossOriginFetch,
): Promise<OGPResponse | null> {
  if (!isPublicWebUrl(url)) {
    return null;
  }

  const abort: AbortController = new AbortController();
  const deadline = setTimeout(
    (): void => abort.abort(),
    DIRECT_FETCH_TIMEOUT_MS,
  );
  try {
    let current: string = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const answer: Response = await fetchFn(current, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: abort.signal,
      });
      if (isRedirect(answer.status)) {
        const location: string | null = answer.headers.get('location');
        if (!location) return null;
        const next: string = new URL(location, current).toString();
        if (!isPublicWebUrl(next)) return null;
        current = next;
        continue;
      }
      // A runtime that followed redirects on its own reports where it
      // ended up; that address is held to the same rule.
      const landed: string = answer.url || current;
      if (landed !== current && !isPublicWebUrl(landed)) return null;
      response = answer;
      break;
    }
    if (!response) return null;

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

    const html: string | null = await readUpTo(
      response,
      DIRECT_FETCH_MAX_BYTES,
    );
    if (html === null) return null;
    const data: OGPMetadata = parseOgpDocument(html, response.url || current);
    return Object.keys(data).length > 0 ? { url, data } : null;
  } finally {
    clearTimeout(deadline);
  }
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * The first `limit` bytes of the body as text, or null when the body is
 * known to be larger than that and cannot be read in part.
 *
 * With a readable stream the read stops at the limit and the rest is never
 * pulled. Without one - the phone's fetch has no streams - the declared
 * length is the guard, and a body that declares more, or declares nothing,
 * is not read: the deadline still bounds it in time, but not in size.
 */
async function readUpTo(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared: number = Number(response.headers.get('content-length') ?? '');
  const body: ReadableStream<Uint8Array> | null | undefined = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const chunks: Uint8Array[] = [];
    let total: number = 0;
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const room: number = limit - total;
        const piece: Uint8Array =
          value.length > room ? value.subarray(0, room) : value;
        chunks.push(piece);
        total += piece.length;
      }
    } finally {
      reader.cancel().catch((): void => {});
    }
    const joined: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(joined);
  }
  if (!Number.isFinite(declared) || declared <= 0 || declared > limit) {
    return null;
  }
  const text: string = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
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

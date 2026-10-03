/**
 * A fetch that goes only to the public web, and stays there.
 *
 * The address is checked, and so is every redirect before it is followed, so
 * a link cannot steer the phone at its router or a metadata service by way
 * of a public hop. A runtime that will not do manual redirects follows them
 * itself; the final address is then checked instead, and a body from a
 * private address is dropped unread. Null means refused, which is not the
 * same as a response that is not ok. The address finally answered from
 * comes back with the response: relative links in a body resolve against it.
 *
 * Was the inside of the OGP fetcher; the zap endpoints needed the same thing.
 */

import { crossOriginFetch } from './native-http.js';
import { isPublicWebUrl } from './url-safety.js';

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;

const MAX_REDIRECTS: number = 3;

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export async function fetchPublic(
  url: string,
  init: RequestInit = {},
  fetchFn: PublicFetch = crossOriginFetch,
): Promise<{ response: Response; url: string } | null> {
  if (!isPublicWebUrl(url)) return null;
  let current: string = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const answer: Response = await fetchFn(current, {
      ...init,
      redirect: 'manual',
    });
    if (answer.type === 'opaqueredirect') {
      // A browser will not say where a redirect goes. Let it follow, and
      // hold the address it lands on to the rule instead; the browser's own
      // cross-origin rules are what keep it off the LAN meanwhile.
      const followed: Response = await fetchFn(current, {
        ...init,
        redirect: 'follow',
      });
      const landed: string = followed.url || current;
      if (!isPublicWebUrl(landed)) return null;
      return { response: followed, url: landed };
    }
    if (isRedirect(answer.status)) {
      const location: string | null = answer.headers.get('location');
      if (!location) return null;
      const next: string = new URL(location, current).toString();
      if (!isPublicWebUrl(next)) return null;
      current = next;
      continue;
    }
    const landed: string = answer.url || current;
    if (landed !== current && !isPublicWebUrl(landed)) return null;
    return { response: answer, url: landed };
  }
  return null;
}

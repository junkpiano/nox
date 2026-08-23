/**
 * Cross-origin HTTP helpers.
 *
 * On the web, cross-origin metadata fetches (OGP, oEmbed, LNURL) are subject to
 * CORS, so the app routes them through the proxy worker. Inside the Tauri shell
 * the request is issued from Rust instead of the WebView, so CORS does not
 * apply and the origin can be contacted directly.
 *
 * The web path is unchanged; only the native runtime takes the direct route.
 */

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

let nativeFetch: Promise<FetchFn> | null = null;

/**
 * Reports whether the app is running inside the Tauri shell.
 *
 * Mirrors `isTauri()` from `@tauri-apps/api/core` without importing it, so the
 * web bundle carries no Tauri code.
 */
export function isNativeRuntime(): boolean {
  return Boolean((globalThis as { isTauri?: boolean }).isTauri);
}

async function loadNativeFetch(): Promise<FetchFn> {
  const module = await import('@tauri-apps/plugin-http');
  return module.fetch as FetchFn;
}

/**
 * Fetches a cross-origin URL, bypassing CORS when running natively.
 *
 * On the web this is a plain `fetch`, so callers that need the proxy must still
 * build the proxy URL themselves.
 *
 * @param url - Absolute URL to request
 * @param init - Standard fetch options
 * @returns The response, or a rejected promise on network failure
 */
export async function crossOriginFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (!isNativeRuntime()) {
    return fetch(url, init);
  }

  if (!nativeFetch) {
    nativeFetch = loadNativeFetch().catch((error: unknown): FetchFn => {
      console.warn(
        '[native-http] Tauri HTTP plugin unavailable, using web fetch:',
        error,
      );
      nativeFetch = null;
      return fetch as FetchFn;
    });
  }

  const fetchImpl: FetchFn = await nativeFetch;
  return fetchImpl(url, init);
}

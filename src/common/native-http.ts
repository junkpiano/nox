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

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

let nativeFetch: Promise<FetchFn> | null = null;

/**
 * A fetch installed by the host platform, used in preference to everything
 * below when present.
 *
 * The question this module actually answers is not "am I Tauri" but "does
 * CORS apply to me", and those stopped being the same question once a second
 * native front end existed. React Native issues requests outside a browser's
 * origin model, so it can reach an origin directly - exactly like the Tauri
 * shell, and unlike a browser tab - but `isNativeRuntime()` says false for it,
 * because it genuinely is not Tauri.
 *
 * Rather than widen that flag until it means two things, the platform installs
 * the fetch it wants and the guessing stops.
 */
let installedFetch: FetchFn | null = null;

export function setCrossOriginFetch(next: FetchFn | null): void {
  installedFetch = next;
}

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
  if (installedFetch) {
    return installedFetch(url, init);
  }

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

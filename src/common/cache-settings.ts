import { kvGet, kvSet } from './kv.js';

const TIMELINE_CACHE_STORAGE_KEY: string = 'timeline_cache_enabled';
const TIMELINE_CACHE_DEFAULT: boolean = true;

/**
 * Twenty-nine lines that used to hold fifteen thousand hostage.
 *
 * Almost every module in the app reaches the cache eventually, the cache asks
 * whether it is enabled, and this asked `localStorage` - which React Native
 * does not have. Reading it through {@link kvGet} instead changes nothing on
 * the web, where the store *is* `localStorage`, and unblocks the native front
 * end entirely.
 *
 * The try/catch that used to be here has moved into the store, which is the
 * only place that knows what can throw.
 */
export function isTimelineCacheEnabled(): boolean {
  const stored: string | null = kvGet(TIMELINE_CACHE_STORAGE_KEY);
  if (stored === null) {
    return TIMELINE_CACHE_DEFAULT;
  }
  return stored === 'true';
}

export function setTimelineCacheEnabled(enabled: boolean): void {
  kvSet(TIMELINE_CACHE_STORAGE_KEY, enabled ? 'true' : 'false');
}

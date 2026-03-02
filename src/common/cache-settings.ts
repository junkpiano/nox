const TIMELINE_CACHE_STORAGE_KEY: string = 'timeline_cache_enabled';
const TIMELINE_CACHE_DEFAULT: boolean = true;

export function isTimelineCacheEnabled(): boolean {
  try {
    const stored: string | null = localStorage.getItem(
      TIMELINE_CACHE_STORAGE_KEY,
    );
    if (stored === null) {
      return TIMELINE_CACHE_DEFAULT;
    }
    return stored === 'true';
  } catch (error: unknown) {
    console.warn('Failed to read timeline cache setting:', error);
    return TIMELINE_CACHE_DEFAULT;
  }
}

export function setTimelineCacheEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(
      TIMELINE_CACHE_STORAGE_KEY,
      enabled ? 'true' : 'false',
    );
  } catch (error: unknown) {
    console.warn('Failed to persist timeline cache setting:', error);
  }
}

/**
 * The seam under every small setting this app keeps.
 *
 * Pubkey, relay list, mute list, cache flags, the profile cache - all of it
 * lives in `localStorage` today, and all of it is read synchronously, from
 * inside functions that have no way to await. React Native has no
 * `localStorage`, so that assumption is the single thing standing between the
 * native front end and roughly fifteen thousand lines of shared logic.
 *
 * The seam is deliberately shaped like `localStorage` rather than like the
 * thing replacing it. Synchronous, string in and string out, null for absent.
 * A nicer async interface here would mean rewriting every caller, which is
 * exactly the cost this is meant to avoid.
 *
 * On the web nothing changes: the default store *is* `localStorage`, so the
 * shipped behaviour, including its failure modes, is byte for byte what it
 * was. Native calls {@link setKvStore} once at start-up with a store it
 * hydrates from disk beforehand, which is how something synchronous can sit
 * on top of storage that is not.
 */

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * Reads and writes `localStorage`, and swallows what it throws.
 *
 * Browsers throw here for reasons that have nothing to do with this app -
 * private windows, disabled site data, a full quota - and every existing
 * caller already treats that as "the setting is absent" rather than as an
 * error worth showing anyone. That behaviour is kept exactly, because
 * changing it would be a change to the web app.
 */
function localStorageKv(): KvStore {
  return {
    get(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Losing a preference is not worth interrupting anyone over.
      }
    },
    remove(key: string): void {
      try {
        localStorage.removeItem(key);
      } catch {
        // As above.
      }
    },
  };
}

/**
 * Holds whatever the store is asked for before one is registered.
 *
 * Native start-up is not instantaneous, and a module read at import time must
 * not blow up because the real store has not been installed yet. Anything
 * written into this is carried over by {@link setKvStore}.
 */
function memoryKv(): KvStore {
  const map: Map<string, string> = new Map();
  return {
    get: (key: string): string | null => map.get(key) ?? null,
    set: (key: string, value: string): void => {
      map.set(key, value);
    },
    remove: (key: string): void => {
      map.delete(key);
    },
  };
}

const hasLocalStorage: boolean = ((): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
})();

let store: KvStore = hasLocalStorage ? localStorageKv() : memoryKv();
let pending: Map<string, string> | null = hasLocalStorage
  ? null
  : new Map<string, string>();

/**
 * Installs the store for this platform. Native calls it once, at start-up,
 * with a store already hydrated from disk.
 *
 * Anything written before this point is replayed into the new store rather
 * than dropped: a setting saved during start-up is still a setting.
 */
export function setKvStore(next: KvStore): void {
  if (pending) {
    for (const [key, value] of pending) {
      next.set(key, value);
    }
    pending = null;
  }
  store = next;
}

export function kvGet(key: string): string | null {
  return store.get(key);
}

export function kvSet(key: string, value: string): void {
  if (pending) {
    pending.set(key, value);
  }
  store.set(key, value);
}

export function kvRemove(key: string): void {
  if (pending) {
    pending.delete(key);
  }
  store.remove(key);
}

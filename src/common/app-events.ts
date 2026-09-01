/**
 * The app's own event bus, which happened to be `window`.
 *
 * Eight places announce that something changed - the relay list, the mute
 * list, the wallet connection, the route - by dispatching a `CustomEvent` on
 * `window`, and other modules listen for it. It works, and on the web there
 * is no reason to change it. React Native simply has no `window` to dispatch
 * on.
 *
 * So emitting moves behind this module while listening does not have to. When
 * `window` exists the event is dispatched exactly as before, which means every
 * existing `window.addEventListener` in the web app keeps working untouched -
 * no coordinated rewrite, no window where half the listeners have moved and
 * half have not. Native has no `window`, gets nothing dispatched, and its
 * listeners subscribe through {@link onAppEvent} instead.
 */

/**
 * The names in use. A union rather than a string so a typo is a compile error
 * instead of a listener that never fires.
 */
export type AppEventName =
  | 'app-route-changed'
  | 'session-changed'
  | 'mute-list-updated'
  | 'dm-messages-updated'
  | 'wallet-connection-changed'
  | 'relays-updated'
  | 'relay-health-updated';

type Handler = (detail: unknown) => void;

const handlers: Map<AppEventName, Set<Handler>> = new Map();

const hasWindow: boolean = ((): boolean => {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    );
  } catch {
    return false;
  }
})();

/**
 * Announces a change. On the web this is still a `CustomEvent` on `window`,
 * so existing listeners are unaffected.
 */
export function emitAppEvent(name: AppEventName, detail?: unknown): void {
  const subscribers: Set<Handler> | undefined = handlers.get(name);
  if (subscribers) {
    // Copied first: a handler that unsubscribes itself must not disturb the
    // iteration it is being called from.
    for (const handler of Array.from(subscribers)) {
      try {
        handler(detail);
      } catch (error: unknown) {
        console.warn(`[events] ${name} handler threw`, error);
      }
    }
  }

  if (hasWindow) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/**
 * Subscribes, and returns the unsubscribe. Returning it rather than exposing
 * a separate `off` is deliberate: a caller that has the handle cannot forget
 * which function it registered.
 */
export function onAppEvent(name: AppEventName, handler: Handler): () => void {
  let subscribers: Set<Handler> | undefined = handlers.get(name);
  if (!subscribers) {
    subscribers = new Set();
    handlers.set(name, subscribers);
  }
  subscribers.add(handler);
  return (): void => {
    subscribers?.delete(handler);
  };
}

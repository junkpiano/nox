/**
 * Asking the viewer a yes/no question, from code that cannot wait for one.
 *
 * There is exactly one of these in the app: NIP-42. A relay demands
 * authentication mid-subscription, and `relay-socket.ts` has to decide, right
 * then, whether to sign a challenge for it. On the web that is `window.confirm`,
 * which blocks the thread until the viewer answers.
 *
 * React Native has no blocking prompt. `Alert.alert` takes callbacks, and
 * there is no way to turn it back into a synchronous boolean. So this seam is
 * deliberately *not* async: making it async would push a promise up through
 * `ensureRelayAuthAllowed` into the socket handler, changing shipped web code
 * for the benefit of one platform.
 *
 * Instead the default is no: when nothing is registered, the answer is
 * "denied", which is exactly what the web code already did when
 * `window.confirm` was unavailable. Native is expected to answer this from a
 * decision the viewer has already made in settings, rather than by
 * interrupting them in the middle of loading a timeline - which is a better
 * shape for the question anyway. A relay asking to authenticate is not an
 * emergency.
 */

export type Asker = (message: string) => boolean;

const hasWindowConfirm: boolean = ((): boolean => {
  try {
    return (
      typeof window !== 'undefined' && typeof window.confirm === 'function'
    );
  } catch {
    return false;
  }
})();

let asker: Asker | null = hasWindowConfirm
  ? (message: string): boolean => window.confirm(message)
  : null;

/**
 * Registers how to answer. Native installs one that consults a stored
 * preference; passing `null` restores "always deny".
 */
export function setAsker(next: Asker | null): void {
  asker = next;
}

/** Whether anything can answer at all. Callers use this to skip the question. */
export function canAsk(): boolean {
  return asker !== null;
}

export function askUser(message: string): boolean {
  if (!asker) {
    return false;
  }
  try {
    return asker(message);
  } catch (error: unknown) {
    console.warn('[ask] the asker threw; treating that as no', error);
    return false;
  }
}

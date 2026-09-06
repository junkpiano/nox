/**
 * A number that changes when the account does.
 *
 * Several screens read `getSessionPrivateKey()` while rendering - to decide
 * whether to draw the compose button, the action row, the reply box - and
 * nothing told them when the answer changed. Signing in on the settings
 * screen and coming back to a timeline with no compose button, until the app
 * was restarted, was the symptom.
 *
 * Re-rendering on `session-changed` is enough: the reads themselves are
 * already fresh.
 */

import { useEffect, useState } from 'react';

import { onAppEvent } from '../../src/common/app-events';

export function useSessionVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(
    (): (() => void) =>
      onAppEvent('session-changed', (): void =>
        setVersion((n: number): number => n + 1),
      ),
    [],
  );
  return version;
}

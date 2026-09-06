/**
 * The navigator, reachable from code that is not a screen.
 *
 * An alert that says "sign in" is only a hint; an alert with a button that
 * takes you there is a way in. The button lives in a helper, not a
 * component, so it needs a way to the navigator that does not go through
 * a hook.
 */

import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../App';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Opens the screen where signing in happens. */
export function openSignIn(): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate('Settings');
  }
}

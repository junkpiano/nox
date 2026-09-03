/**
 * What a write control does on the phone when the session may not write.
 *
 * The control stays on screen and says why it does nothing: a button that
 * disappears teaches nothing, and the person browsing as a key is exactly
 * the one deciding whether to sign in. So the explanation carries the way
 * in: one tap on "Sign in" opens the screen where that happens.
 */

import { Alert } from 'react-native';
import { getSession } from '../../src/common/session';
import { canWrite } from '../../src/common/signer';
import { openSignIn } from './navigation';

/** Says why writing is off, and offers the way in. */
export function signInPrompt(title: string, message: string): void {
  Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Sign in', onPress: openSignIn },
  ]);
}

/** True when the session may publish; otherwise says why not and is false. */
export function guardWrite(): boolean {
  if (canWrite()) return true;
  if (getSession().kind === 'read-only') {
    signInPrompt('Read-only', 'Sign in to post, like or follow.');
  } else {
    signInPrompt('Not signed in', 'Sign in to take part.');
  }
  return false;
}

/** Whether write controls should be drawn at all: somebody is here. */
export function hasViewer(): boolean {
  return getSession().kind !== 'none';
}

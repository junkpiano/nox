/**
 * What a write control does on the phone when the session may not write.
 *
 * The control stays on screen and says why it does nothing: a button that
 * disappears teaches nothing, and the person browsing as a key is exactly
 * the one deciding whether to sign in. One sentence, one place.
 */

import { Alert } from 'react-native';
import { getSession } from '../../src/common/session';
import { canWrite } from '../../src/common/signer';

/** True when the session may publish; otherwise says why not and is false. */
export function guardWrite(): boolean {
  if (canWrite()) return true;
  if (getSession().kind === 'read-only') {
    Alert.alert('Read-only', 'Sign in on the You tab to post, like or follow.');
  } else {
    Alert.alert('Not signed in', 'Add a key on the You tab to take part.');
  }
  return false;
}

/** Whether write controls should be drawn at all: somebody is here. */
export function hasViewer(): boolean {
  return getSession().kind !== 'none';
}

/**
 * Marks the document so CSS can target the native shell.
 *
 * Layout itself branches on viewport width, not on the runtime, so the mobile
 * web build gets the same treatment as the app. This flag is only for the
 * handful of things that are meaningless in a browser tab: drawing under the
 * status bar, suppressing the tap highlight and rubber-band scrolling, and
 * treating the UI chrome as chrome rather than as selectable text.
 */

import { isNativeRuntime } from './native-http.js';

export function applyPlatformClass(): void {
  if (isNativeRuntime()) {
    document.documentElement.dataset.runtime = 'native';
  }
}

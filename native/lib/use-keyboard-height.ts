/**
 * How much of the screen the keyboard covers, right now.
 *
 * The app draws edge to edge, and under edge-to-edge Android no longer
 * resizes the window for the keyboard: `adjustResize` in the manifest is
 * ignored, and a field at the bottom of a screen simply disappears under
 * the keys. The height has to be read and applied by hand. The keyboard
 * events carry it on both platforms; a screen pads its bottom by this much
 * and its flexible field shrinks to fit what is left.
 *
 * The number is what the app must pad to clear the keys. React Native's
 * Android event reports the keyboard less the system bar it covers, so the
 * bar's inset is added back there; iOS reports the keyboard's whole frame.
 */

import { useEffect, useState } from 'react';
import { Keyboard, type KeyboardEvent, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  const insets = useSafeAreaInsets();
  useEffect((): (() => void) => {
    // iOS announces the keyboard before it moves; Android only once it has.
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const shown = Keyboard.addListener(
      showEvent,
      (event: KeyboardEvent): void => setHeight(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener(hideEvent, (): void => setHeight(0));
    return (): void => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  if (height === 0) return 0;
  return Platform.OS === 'android' ? height + insets.bottom : height;
}

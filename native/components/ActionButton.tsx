/**
 * One button in a post's action row: reply, repost, like, react, more.
 *
 * Shared by the timeline card and the thread, so the row is the same size,
 * colour and reach everywhere. 44 points square is Apple's minimum touch
 * target and above Android's 48dp once the row's spacing is counted.
 */

import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import type { IconName } from '../../src/common/icons';
import Icon from './Icon';

const SIZE: number = 22;
const IDLE: string = '#7283aa';
const DONE: string = '#73f0c1';

export default function ActionButton({
  icon,
  label,
  onPress,
  done = false,
  busy = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Given already: a like, a repost. Drawn in the accent. */
  done?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: done, busy, disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={IDLE} />
      ) : (
        <Icon name={icon} size={SIZE} color={done ? DONE : IDLE} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  pressed: { backgroundColor: 'rgba(137, 168, 255, 0.14)' },
});

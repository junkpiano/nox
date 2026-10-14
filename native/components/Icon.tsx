/**
 * An icon from the shared table (src/common/icons.ts): an SF Symbol on iOS,
 * a Material Symbol on Android.
 */

import { SymbolView } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { ICONS, type IconName } from '../../src/common/icons';

export default function Icon({
  name,
  size,
  color,
}: {
  name: IconName;
  size: number;
  color: ColorValue;
}) {
  const icon = ICONS[name];
  return (
    <SymbolView
      // biome-ignore lint/suspicious/noExplicitAny: the table's names are strings; both libraries check them at runtime
      name={{ ios: icon.sf as any, android: icon.material as any }}
      size={size}
      tintColor={color}
      weight="regular"
    />
  );
}

/**
 * Navigation is `@react-navigation/native-stack` rather than expo-router.
 *
 * expo-router was the first choice, for its deep links - a Nostr client wants
 * `nostr:` and npub URLs to open a screen. It had to go: it pulls in
 * react-native-reanimated 4.6, which pulls react-native-worklets 0.12.1, which
 * is outside the `^0.7 || ^0.8 || ^0.9 || ^0.10` range expo-modules-core 57
 * declares. npm only warns about that; the mismatch actually surfaces as a C++
 * compile error deep in expo-modules-core, `no member named 'executeSync'`.
 *
 * native-stack needs neither, and `expo-linking` still gives us the deep links.
 */
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { PubkeyHex } from '../types/nostr';
import Home from './screens/Home';
import Profile from './screens/Profile';
import Thread from './screens/Thread';
import SharedCodeCheck from './screens/SharedCodeCheck';

export type RootStackParamList = {
  Home: undefined;
  Profile: { pubkey: PubkeyHex };
  Thread: { eventId: string };
  SharedCodeCheck: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const theme = {
  dark: true,
  colors: {
    primary: '#89a8ff',
    background: '#0b1220',
    card: '#0b1220',
    text: '#f5f8ff',
    border: '#25406e',
    notification: '#ff9a9a',
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium: { fontFamily: 'System', fontWeight: '500' as const },
    bold: { fontFamily: 'System', fontWeight: '700' as const },
    heavy: { fontFamily: 'System', fontWeight: '900' as const },
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={theme}>
        <Stack.Navigator>
          <Stack.Screen
            name="Home"
            component={Home}
            options={{ title: 'nox' }}
          />
          <Stack.Screen
            name="Profile"
            component={Profile}
            options={{ title: 'Profile' }}
          />
          <Stack.Screen
            name="Thread"
            component={Thread}
            options={{ title: 'Thread' }}
          />
          <Stack.Screen
            name="SharedCodeCheck"
            component={SharedCodeCheck}
            options={{ title: 'shared code' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

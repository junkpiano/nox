/**
 * Navigation: a bottom tab bar under a native stack.
 *
 * Tabs rather than a drawer, because the web build already moved to a tab bar
 * on narrow screens and because a tab bar is what the platform expects. The
 * stack sits above them, so opening a profile or a thread covers the tabs and
 * comes back with the system's own gesture.
 *
 * `@react-navigation/native-stack`, not expo-router. expo-router was the first
 * choice for its deep links - a Nostr client wants `nostr:` and npub URLs to
 * open a screen - and it had to go: it pulls react-native-reanimated 4.6,
 * which pulls react-native-worklets 0.12.1, outside the
 * `^0.7 || ^0.8 || ^0.9 || ^0.10` range expo-modules-core 57 declares. npm
 * only warns; the mismatch actually surfaces as a C++ error inside
 * expo-modules-core, `no member named 'executeSync'`, after two and a half
 * minutes of compiling. `expo-linking` still gives us the deep links.
 */
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { PubkeyHex } from '../types/nostr';
import Global from './screens/Global';
import Home from './screens/Home';
import Profile from './screens/Profile';
import Relays from './screens/Relays';
import Search from './screens/Search';
import SharedCodeCheck from './screens/SharedCodeCheck';
import Thread from './screens/Thread';

export type RootStackParamList = {
  Tabs: undefined;
  Profile: { pubkey: PubkeyHex };
  Thread: { eventId: string };
};

export type TabParamList = {
  Home: undefined;
  Global: undefined;
  Search: undefined;
  Relays: undefined;
  Checks: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

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

/** An emoji stands in for an icon set until the app has one of its own. */
function icon(glyph: string) {
  return ({ color }: { color: string }) => (
    <Text style={{ fontSize: 18, color }}>{glyph}</Text>
  );
}

function TabBar() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0b1220' },
        headerTintColor: '#f5f8ff',
        tabBarStyle: {
          backgroundColor: '#0b1220',
          borderTopColor: '#25406e',
        },
        tabBarActiveTintColor: '#89a8ff',
        tabBarInactiveTintColor: '#5b6b88',
      }}
    >
      <Tabs.Screen
        name="Home"
        component={Home}
        options={{ title: 'Home', tabBarIcon: icon('🏠') }}
      />
      <Tabs.Screen
        name="Global"
        component={Global}
        options={{ title: 'Global', tabBarIcon: icon('🌍') }}
      />
      <Tabs.Screen
        name="Search"
        component={Search}
        options={{ title: 'Search', tabBarIcon: icon('🔍') }}
      />
      <Tabs.Screen
        name="Relays"
        component={Relays}
        options={{ title: 'Relays', tabBarIcon: icon('📡') }}
      />
      <Tabs.Screen
        name="Checks"
        component={SharedCodeCheck}
        options={{ title: 'Shared code', tabBarIcon: icon('🧪') }}
      />
    </Tabs.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={theme}>
        <Stack.Navigator>
          <Stack.Screen
            name="Tabs"
            component={TabBar}
            options={{ headerShown: false }}
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
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

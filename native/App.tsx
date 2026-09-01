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
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { hidesWallet } from '../src/common/platform';
import type { PubkeyHex } from '../types/nostr';
import Chat from './screens/Chat';
import Compose from './screens/Compose';
import Feed from './screens/Feed';
import Messages from './screens/Messages';
import Notifications from './screens/Notifications';
import Profile from './screens/Profile';
import Relays from './screens/Relays';
import Search from './screens/Search';
import Settings from './screens/Settings';
import SharedCodeCheck from './screens/SharedCodeCheck';
import Thread from './screens/Thread';
import Wallet from './screens/Wallet';
import You from './screens/You';

export type RootStackParamList = {
  Tabs: undefined;
  You: undefined;
  Settings: undefined;
  Compose: undefined;
  Relays: undefined;
  Checks: undefined;
  Profile: { pubkey: PubkeyHex };
  Thread: { eventId: string };
  Chat: { peer: PubkeyHex; name: string };
  Wallet: undefined;
};

/**
 * Four tabs.
 *
 * A tab bar is a promise that these are the places you go often, and eight of
 * them was not that - it was a menu wearing a tab bar's clothes, with labels
 * truncated to fit. Global moved in beside Home, which is where it belongs;
 * the relay list, the account and the shared-code checks moved behind the
 * header button, because they are visited on purpose rather than by habit.
 */
export type TabParamList = {
  Feed: undefined;
  Search: undefined;
  Messages: undefined;
  Alerts: undefined;
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

/** Your profile, which the tab bar no longer has room to name. */
function AccountButton() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <Pressable
      onPress={(): void => navigation.navigate('You')}
      hitSlop={12}
      style={{ paddingHorizontal: 16 }}
    >
      <Text style={{ fontSize: 20 }}>👤</Text>
    </Pressable>
  );
}

/** Settings sit behind the profile, one step further in than the profile is. */
function SettingsButton() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <Pressable
      onPress={(): void => navigation.navigate('Settings')}
      hitSlop={12}
      style={{ paddingHorizontal: 16 }}
    >
      <Text style={{ fontSize: 20 }}>⚙️</Text>
    </Pressable>
  );
}

function TabBar() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0b1220' },
        headerTintColor: '#f5f8ff',
        headerRight: () => <AccountButton />,
        tabBarStyle: {
          backgroundColor: '#0b1220',
          borderTopColor: '#25406e',
        },
        tabBarActiveTintColor: '#89a8ff',
        tabBarInactiveTintColor: '#5b6b88',
      }}
    >
      <Tabs.Screen
        name="Feed"
        component={Feed}
        options={{ title: 'Home', tabBarIcon: icon('🏠') }}
      />
      <Tabs.Screen
        name="Search"
        component={Search}
        options={{ title: 'Search', tabBarIcon: icon('🔍') }}
      />
      <Tabs.Screen
        name="Messages"
        component={Messages}
        options={{ title: 'DMs', tabBarIcon: icon('✉️') }}
      />
      <Tabs.Screen
        name="Alerts"
        component={Notifications}
        options={{ title: 'Alerts', tabBarIcon: icon('🔔') }}
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
            name="You"
            component={You}
            options={{ title: 'You', headerRight: () => <SettingsButton /> }}
          />
          <Stack.Screen
            name="Settings"
            component={Settings}
            options={{ title: 'Settings' }}
          />
          <Stack.Screen
            name="Compose"
            component={Compose}
            options={{ title: 'New note' }}
          />
          <Stack.Screen
            name="Relays"
            component={Relays}
            options={{ title: 'Relays' }}
          />
          <Stack.Screen
            name="Checks"
            component={SharedCodeCheck}
            options={{ title: 'Shared code' }}
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
            name="Chat"
            component={Chat}
            options={({ route }) => ({ title: route.params.name })}
          />
          {/* Not registered at all on iOS. A route that exists but is not
              linked to is still a route, and this one must not be reachable
              there by any means. */}
          {hidesWallet() ? null : (
            <Stack.Screen
              name="Wallet"
              component={Wallet}
              options={{ title: 'Wallet' }}
            />
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

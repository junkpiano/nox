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
import {
  type LinkingOptions,
  NavigationContainer,
  useNavigation,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Image, Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { onAppEvent } from '../src/common/app-events';
import { kvGet } from '../src/common/kv';
import { resolveNostrLink } from '../src/common/nostr-link';
import { hidesWallet } from '../src/common/platform';
import { getSession } from '../src/common/session';
import { hasAcceptedTerms } from '../src/common/terms';
import type { PubkeyHex } from '../types/nostr';
import { fetchProfilesForPubkeys } from './lib/home-timeline';
import About from './screens/About';
import Chat from './screens/Chat';
import Compose from './screens/Compose';
import Feed from './screens/Feed';
import Hashtag from './screens/Hashtag';
import Likes from './screens/Likes';
import Messages from './screens/Messages';
import Notifications from './screens/Notifications';
import Profile from './screens/Profile';
import Relays from './screens/Relays';
import Search from './screens/Search';
import Settings from './screens/Settings';
import SharedCodeCheck from './screens/SharedCodeCheck';
import Terms from './screens/Terms';
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
  /**
   * `reply` opens the thread with the composer already up. `relays` are the
   * hints an nevent carried: where the note is known to be, tried first.
   */
  Thread: { eventId: string; reply?: boolean; relays?: string[] };
  Chat: { peer: PubkeyHex; name: string };
  Wallet: undefined;
  Hashtag: { tag: string };
  Likes: undefined;
  About: undefined;
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

/**
 * Links into the app.
 *
 * A `nostr:` URI from another client, a `web+nostr:` one from a browser, a
 * link to nox.garden, or the app's own scheme: each names a person, a note
 * or a tag, and the shared resolver says which. The screen is pushed on top
 * of the tabs, so the back gesture returns to the timeline rather than to
 * nowhere. A link the resolver does not understand opens the front door.
 */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [
    'nox://',
    'nox:',
    'nostr:',
    'web+nostr:',
    'https://nox.garden',
    'https://www.nox.garden',
  ],
  getStateFromPath: (path: string) => {
    const target = resolveNostrLink(path);
    const home = { name: 'Tabs' as const };
    if (!target) return { routes: [home] };
    switch (target.kind) {
      case 'profile':
        return {
          routes: [
            home,
            { name: 'Profile', params: { pubkey: target.pubkey } },
          ],
        };
      case 'event':
        return {
          routes: [
            home,
            {
              name: 'Thread',
              params: { eventId: target.eventId, relays: target.relays },
            },
          ],
        };
      case 'hashtag':
        return {
          routes: [home, { name: 'Hashtag', params: { tag: target.tag } }],
        };
    }
  },
};

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

/**
 * Your profile, which the tab bar no longer has room to name.
 *
 * Shows your own face once there is one. A generic glyph in the corner is the
 * same button whoever is signed in, which is exactly the thing this button is
 * for telling you.
 */
function AccountButton() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [picture, setPicture] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<boolean>(false);

  useEffect((): (() => void) => {
    const load = (): void => {
      const stored = kvGet('nostr_pubkey');
      setBrowsing(getSession().kind === 'read-only');
      if (!stored || !/^[0-9a-f]{64}$/i.test(stored)) {
        setPicture(null);
        return;
      }
      void fetchProfilesForPubkeys([stored.toLowerCase() as PubkeyHex])
        .then((profiles): void => {
          setPicture(profiles.get(stored.toLowerCase())?.picture ?? null);
        })
        .catch((): void => setPicture(null));
    };
    load();
    return onAppEvent('session-changed', load);
  }, []);

  return (
    <Pressable
      onPress={(): void => navigation.navigate('You')}
      hitSlop={12}
      style={{ paddingHorizontal: 16 }}
    >
      {picture ? (
        <Image
          source={{ uri: picture }}
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: '#25406e',
          }}
        />
      ) : (
        <Text style={{ fontSize: 20 }}>👤</Text>
      )}
      {/* Browsing as a key: the eye says so on every screen, so a read-only
          session is never mistaken for a sign-in. */}
      {browsing ? (
        <Text
          accessibilityLabel="Read-only session"
          style={{
            position: 'absolute',
            right: 8,
            bottom: -4,
            fontSize: 11,
            backgroundColor: '#0b1220',
            borderRadius: 8,
            paddingHorizontal: 2,
          }}
        >
          👁
        </Text>
      ) : null}
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
  /**
   * Read once, synchronously, before the first frame. An asynchronous answer
   * would mean either a flash of the timeline behind the gate or a blank
   * screen while it resolves, and the first of those defeats the gate.
   */
  const [accepted, setAccepted] = useState<boolean>(hasAcceptedTerms);

  if (!accepted) {
    // No navigator underneath: there is nothing to reach past this, by a deep
    // link or otherwise.
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Terms onAccept={(): void => setAccepted(true)} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer theme={theme} linking={linking}>
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
            name="Hashtag"
            component={Hashtag}
            options={({ route }) => ({ title: `#${route.params.tag}` })}
          />
          <Stack.Screen
            name="Chat"
            component={Chat}
            options={({ route }) => ({ title: route.params.name })}
          />
          <Stack.Screen
            name="Likes"
            component={Likes}
            options={{ title: 'Likes' }}
          />
          <Stack.Screen
            name="About"
            component={About}
            options={{ title: 'About nox' }}
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

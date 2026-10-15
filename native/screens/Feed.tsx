/**
 * The two timelines, under one tab.
 *
 * Home and Global are both "a list of posts from the relays" and differ only
 * in which posts they ask for, so they belong beside each other rather than in
 * separate tabs - which is also what makes room in the tab bar for the things
 * that are genuinely different.
 *
 * Both panes stay mounted once seen, hidden rather than unmounted. Global
 * costs a thousand events and about ten seconds to fill; throwing that away
 * every time somebody glances at Home and back would make the switch feel
 * broken. Global is not mounted at all until it is first chosen, so an install
 * that never opens it never pays for it.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getSessionPrivateKey } from '../../src/common/session';
import type { RootStackParamList } from '../App';
import { useSessionVersion } from '../lib/use-session-version';
import Global from './Global';
import Home from './Home';

type Which = 'home' | 'global';

export default function Feed() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [which, setWhich] = useState<Which>('home');
  const insets = useSafeAreaInsets();
  const [globalMounted, setGlobalMounted] = useState(false);
  // Read below at render; this is what makes the read happen again after a
  // sign-in, rather than on the next restart.
  useSessionVersion();

  const choose = (next: Which): void => {
    if (next === 'global') {
      setGlobalMounted(true);
    }
    setWhich(next);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.switcher}>
        {(['home', 'global'] as Which[]).map((option: Which) => {
          const on = option === which;
          return (
            <Pressable
              key={option}
              onPress={(): void => choose(option)}
              style={[styles.segment, on && styles.segmentOn]}
            >
              <Text style={on ? styles.segmentTextOn : styles.segmentText}>
                {option === 'home' ? 'Following' : 'Global'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.pane, which !== 'home' && styles.hidden]}>
        <Home active={which === 'home'} />
      </View>
      {globalMounted ? (
        <View style={[styles.pane, which !== 'global' && styles.hidden]}>
          <Global active={which === 'global'} />
        </View>
      ) : null}

      {/* Only with a key. A compose button that opens a screen which can only
          say "not signed in" is a worse answer than not offering it. */}
      {getSessionPrivateKey() ? (
        <Pressable
          onPress={(): void => navigation.navigate('Compose')}
          style={[styles.fab, { bottom: insets.bottom + TAB_BAR + 16 }]}
        >
          <Text style={styles.fabText}>✎</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The system tab bar's height above the device's own inset. The screen runs
 * underneath it, and the bar takes the touches in its area, so the button is
 * placed clear of it rather than at a guess.
 */
const TAB_BAR: number = Platform.OS === 'ios' ? 49 : 80;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  switcher: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#25406e',
  },
  segment: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 999,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segmentOn: { borderColor: '#89a8ff', backgroundColor: '#16233f' },
  segmentText: { color: '#8ea0c0', fontSize: 13, fontWeight: '600' },
  segmentTextOn: { color: '#e8eeff', fontSize: 13, fontWeight: '700' },
  pane: { flex: 1 },
  hidden: { display: 'none' },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#89a8ff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    zIndex: 10,
  },
  fabText: { color: '#0b1220', fontSize: 24, fontWeight: '700' },
});

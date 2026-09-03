/**
 * About nox: what it is, what it honours, where to say thanks.
 *
 * The list of NIPs comes from the shared module the web's About page reads,
 * so the two never disagree about what the app does.
 */

import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  nipLabel,
  nipUrl,
  SUPPORTED_NIPS,
  type SupportedNip,
  ZAP_ADDRESS,
} from '../../src/common/supported-nips';

const SITE: string = 'https://nox.garden';

export default function About() {
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const copyAddress = async (): Promise<void> => {
    try {
      await Clipboard.setStringAsync(ZAP_ADDRESS);
      setCopied(true);
      setTimeout((): void => setCopied(false), 2000);
    } catch {
      // Nothing to say; the address is on screen to be read.
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: 24 + insets.bottom },
      ]}
    >
      <Text style={styles.heading}>A practical relay client</Text>
      <Text style={styles.body}>
        nox talks to your relays directly. There is no server in the middle, no
        account, and your key stays on this phone. What you see comes from the
        relays you chose, judged by rules you can read in the code.
      </Text>

      <Text style={styles.heading}>Supported NIPs</Text>
      <View style={styles.list}>
        {SUPPORTED_NIPS.map((entry: SupportedNip) => (
          <Pressable
            key={entry.nip}
            onPress={(): void => {
              void Linking.openURL(nipUrl(entry.nip));
            }}
            style={styles.row}
          >
            <Text style={styles.nip}>{nipLabel(entry.nip)}</Text>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{entry.title}</Text>
              {entry.note ? (
                <Text style={styles.rowNote}>{entry.note}</Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </View>

      <Text style={styles.heading}>Privacy and terms</Text>
      <Text style={styles.body}>
        Content comes from the Nostr network and is not moderated by nox. Mute
        and report are on every post and profile.
      </Text>
      <View style={styles.links}>
        <Pressable
          onPress={(): void => {
            void Linking.openURL(`${SITE}/privacy`);
          }}
        >
          <Text style={styles.link}>Privacy policy</Text>
        </Pressable>
        <Pressable
          onPress={(): void => {
            void Linking.openURL(`${SITE}/terms`);
          }}
        >
          <Text style={styles.link}>Terms of use</Text>
        </Pressable>
      </View>

      <Text style={styles.heading}>Say thanks</Text>
      <Text style={styles.body}>
        If nox is useful to you, a zap to the address below goes to its
        development.
      </Text>
      <Pressable onPress={copyAddress} style={styles.address}>
        <Text style={styles.addressText}>{ZAP_ADDRESS}</Text>
        <Text style={styles.addressHint}>
          {copied ? 'Copied' : 'Tap to copy'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  content: { padding: 20, gap: 10 },
  heading: {
    color: '#f5f8ff',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 14,
  },
  body: { color: '#b9c6de', fontSize: 14, lineHeight: 20 },
  list: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    backgroundColor: '#101a2e',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148,163,184,0.14)',
  },
  nip: { color: '#89a8ff', fontSize: 13, fontWeight: '700', width: 60 },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { color: '#e8eeff', fontSize: 14 },
  rowNote: { color: '#5b6b88', fontSize: 11 },
  links: { flexDirection: 'row', gap: 20 },
  link: { color: '#89a8ff', fontSize: 14, textDecorationLine: 'underline' },
  address: {
    borderWidth: 1,
    borderColor: '#25563f',
    backgroundColor: '#0f1f18',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  addressText: { color: '#73f0c1', fontSize: 14, fontFamily: 'monospace' },
  addressHint: { color: '#5b6b88', fontSize: 11 },
});

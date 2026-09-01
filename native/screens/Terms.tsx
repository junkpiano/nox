/**
 * The gate.
 *
 * Rendered instead of the app, not over it: there is no navigator underneath
 * this, so there is nothing to reach past it, through history, or by a deep
 * link. The global timeline is unfiltered by definition and would otherwise be
 * the first thing a new install shows a stranger.
 *
 * There is no "decline" button. Declining is closing the app, which is already
 * a button the phone provides, and a decline that returns you to a disabled
 * app is a worse answer than an honest dead end.
 */

import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  acceptTerms,
  PRIVACY_URL,
  TERMS_SUMMARY,
  TERMS_URL,
  type TermsPoint,
} from '../../src/common/terms';

export default function Terms({ onAccept }: { onAccept: () => void }) {
  const accept = (): void => {
    acceptTerms();
    onAccept();
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Before you start</Text>
        <Text style={styles.lede}>
          nox is a Nostr client. A few things are worth knowing first, because
          none of them can be undone afterwards.
        </Text>

        {TERMS_SUMMARY.map((point: TermsPoint) => (
          <View key={point.heading} style={styles.point}>
            <Text style={styles.heading}>{point.heading}</Text>
            <Text style={styles.text}>{point.body}</Text>
          </View>
        ))}

        <Text style={styles.text}>
          Tapping Agree accepts the{' '}
          <Text
            style={styles.link}
            onPress={(): void => {
              void Linking.openURL(TERMS_URL);
            }}
          >
            Terms of Use
          </Text>{' '}
          and the{' '}
          <Text
            style={styles.link}
            onPress={(): void => {
              void Linking.openURL(PRIVACY_URL);
            }}
          >
            Privacy Policy
          </Text>
          , which say all of this in full. You must be at least 13.
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable onPress={accept} style={styles.button}>
          <Text style={styles.buttonText}>Agree and continue</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  body: { padding: 24, paddingTop: 64, gap: 18 },
  title: { color: '#f5f8ff', fontSize: 26, fontWeight: '700' },
  lede: { color: '#b9c6de', fontSize: 15, lineHeight: 22 },
  point: { gap: 5 },
  heading: { color: '#e8eeff', fontSize: 15, fontWeight: '700' },
  text: { color: '#8ea0c0', fontSize: 14, lineHeight: 20 },
  link: { color: '#89a8ff', textDecorationLine: 'underline' },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#25406e',
  },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 16 },
});

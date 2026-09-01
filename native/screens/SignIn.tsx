/**
 * Signing in, and the fact that on a phone that means holding a key.
 *
 * The web build can lean on a NIP-07 extension and never see the secret. No
 * such thing exists here, so the choice is between pasting an `nsec` and
 * generating one - and either way the app holds the key. That is stated on
 * the screen rather than left to be inferred, because someone pasting their
 * real key deserves to know where it is about to live.
 *
 * The key goes to `setSessionPrivateKeyFromRaw`, shared with the web app,
 * which writes it through the secret store - the Android Keystore here, the
 * iOS Keychain when that build exists. It is never put in the ordinary
 * settings store, never logged, and never sent anywhere.
 */

import { generateSecretKey, nip19 } from 'nostr-tools';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { kvRemove, kvSet } from '../../src/common/kv';
import {
  clearSessionPrivateKey,
  getSessionNsec,
  setSessionPrivateKeyFromRaw,
} from '../../src/common/session';
import type { PubkeyHex } from '../../types/nostr';

const PUBKEY_KEY = 'nostr_pubkey';

export default function SignIn({
  signedInAs,
  viewingAs,
  onChange,
}: {
  /** Holding this person's private key: posting is possible. */
  signedInAs: PubkeyHex | null;
  /** Reading this person's timeline with no key: posting is not. */
  viewingAs: PubkeyHex | null;
  onChange: (next: PubkeyHex | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const adopt = (raw: string): void => {
    try {
      const next: PubkeyHex = setSessionPrivateKeyFromRaw(raw.trim());
      kvSet(PUBKEY_KEY, next);
      setDraft('');
      setError(null);
      onChange(next);
    } catch (e: any) {
      // The message is the library's, not the input: echoing what was typed
      // would put a private key on screen inside an error.
      setError(`That key was not accepted: ${String(e?.message ?? e)}`);
    }
  };

  const generate = (): void => {
    const nsec: string = nip19.nsecEncode(generateSecretKey());
    adopt(nsec);
    Alert.alert(
      'A new key was created',
      'It exists only on this phone. Back it up from this screen, or it is ' +
        'gone if the app is removed - there is nobody to reset it with.',
    );
  };

  const signOut = (): void => {
    Alert.alert('Sign out?', 'The key is deleted from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: (): void => {
          clearSessionPrivateKey();
          kvRemove(PUBKEY_KEY);
          setRevealed(null);
          onChange(null);
        },
      },
    ]);
  };

  if (signedInAs) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Signed in</Text>
        <Text style={styles.npub} selectable>
          {nip19.npubEncode(signedInAs)}
        </Text>

        <Text style={styles.section}>Back up your key</Text>
        <Text style={styles.body}>
          There is no account to recover. If this phone is lost and the key is
          not written down anywhere, the identity is gone.
        </Text>

        {revealed ? (
          <Text style={styles.secret} selectable>
            {revealed}
          </Text>
        ) : (
          <Pressable
            onPress={(): void => setRevealed(getSessionNsec())}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Show my nsec</Text>
          </Pressable>
        )}

        <Pressable onPress={signOut} style={styles.danger}>
          <Text style={styles.dangerText}>Sign out and delete the key</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sign in</Text>

      {viewingAs ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Reading {nip19.npubEncode(viewingAs).slice(0, 16)}...'s timeline
            without their key, which is why there is nothing to post with. Sign
            in below to write as yourself.
          </Text>
        </View>
      ) : null}
      <Text style={styles.body}>
        A browser can keep your key in an extension. A phone cannot, so this app
        holds it - in the device credential store, available only while the
        phone is unlocked, and not carried to another device by a backup.
      </Text>

      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="nsec1..."
        placeholderTextColor="#5b6b88"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable onPress={(): void => adopt(draft)} style={styles.button}>
        <Text style={styles.buttonText}>Use this key</Text>
      </Pressable>

      <Text style={styles.or}>or</Text>

      <Pressable onPress={generate} style={styles.secondary}>
        <Text style={styles.secondaryText}>Create a new key</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  content: { padding: 24, gap: 12 },
  title: { color: '#f5f8ff', fontSize: 22, fontWeight: '700' },
  section: {
    color: '#f5f8ff',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 20,
  },
  body: { color: '#8ea0c0', fontSize: 13, lineHeight: 20 },
  npub: { color: '#89a8ff', fontSize: 12, marginTop: 4 },
  secret: {
    color: '#ffd79a',
    fontSize: 12,
    lineHeight: 18,
    backgroundColor: '#241b0f',
    borderRadius: 10,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
    marginTop: 8,
  },
  error: { color: '#ff9a9a', fontSize: 12 },
  notice: {
    backgroundColor: '#16233f',
    borderRadius: 10,
    padding: 12,
  },
  noticeText: { color: '#8ea0c0', fontSize: 12, lineHeight: 18 },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
  or: { color: '#5b6b88', fontSize: 12, textAlign: 'center' },
  secondary: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryText: { color: '#89a8ff', fontWeight: '700', fontSize: 15 },
  danger: {
    borderWidth: 1,
    borderColor: '#5c2733',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 24,
  },
  dangerText: { color: '#ff9a9a', fontWeight: '700', fontSize: 15 },
});

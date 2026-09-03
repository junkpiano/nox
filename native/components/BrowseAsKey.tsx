/**
 * The way in without a secret.
 *
 * A public key is enough to draw somebody's timeline, profile and likes,
 * and asks nothing of the person typing it. This is the lighter commitment
 * of the two ways in, and it is drawn that way: a dashed rule above it, a
 * secondary button, and a note that says plainly what it cannot do.
 *
 * The session it starts is the shared read-only kind: every screen reads
 * that key, and nothing can be signed until someone signs in for real.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { emitAppEvent } from '../../src/common/app-events';
import {
  InvalidPublicKeyError,
  startReadOnlySession,
} from '../../src/common/session';
import type { PubkeyHex } from '../../types/nostr';

export default function BrowseAsKey({
  onStarted,
}: {
  onStarted?: ((pubkey: PubkeyHex) => void) | undefined;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const browse = (): void => {
    try {
      const pubkey: PubkeyHex = startReadOnlySession(text);
      setText('');
      setError(null);
      // Every screen holding a viewer has to be told, the timeline first.
      emitAppEvent('session-changed');
      onStarted?.(pubkey);
    } catch (e: unknown) {
      setError(
        e instanceof InvalidPublicKeyError
          ? e.message
          : 'Could not start browsing with that key.',
      );
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.kicker}>JUST LOOKING?</Text>
      <TextInput
        value={text}
        onChangeText={(next: string): void => {
          setText(next);
          setError(null);
        }}
        placeholder="npub1… or 64-character hex"
        placeholderTextColor="#5b6b88"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Public key to browse as"
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable onPress={browse} style={styles.button}>
        <Text style={styles.buttonText}>Browse</Text>
      </Pressable>
      <Text style={styles.note}>
        Shows the timeline, profile and likes that key sees. Nothing can be
        posted, and no secret is asked for: to post, sign in.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 10,
    paddingTop: 18,
    borderTopWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(148,163,184,0.35)',
  },
  kicker: {
    color: '#7fd5ff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2.5,
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
  },
  error: { color: '#ff9a9a', fontSize: 12 },
  button: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonText: { color: '#89a8ff', fontWeight: '700', fontSize: 15 },
  note: { color: '#5b6b88', fontSize: 12, lineHeight: 17 },
});

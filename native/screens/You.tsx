/**
 * Your own profile.
 *
 * The same page anybody else's profile is, which is the point: what you look
 * like to other people is the thing worth showing under your own name. This
 * screen used to be a settings page - sign-in, a compose box, a key backup, a
 * word list and three navigation rows in one scroll - and calling that "You"
 * was a promise it did not keep.
 *
 * Settings moved behind the header. Composing moved to the button on the
 * timeline, where the thing being written is going.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { kvGet } from '../../src/common/kv';
import { restoreSessionPrivateKey } from '../../src/common/session';
import type { PubkeyHex } from '../../types/nostr';
import { ProfileView } from './Profile';
import SignIn from './SignIn';

function readStoredPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

export default function You() {
  const [viewer, setViewer] = useState<PubkeyHex | null>(readStoredPubkey);
  const [ready, setReady] = useState(false);

  // The key lives in the credential store and cannot be read synchronously.
  // Nothing here signs, but the screens reached from here do.
  useEffect(() => {
    void restoreSessionPrivateKey().then((): void => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  if (!viewer) {
    return (
      <View style={styles.screen}>
        <SignIn signedInAs={null} viewingAs={null} onChange={setViewer} />
      </View>
    );
  }

  return <ProfileView pubkey={viewer} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
  },
});

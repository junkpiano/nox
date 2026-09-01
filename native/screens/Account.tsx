/**
 * The account tab: who you are, and writing a note.
 *
 * Composing lives here rather than behind a floating button because there is
 * nothing else to put on this tab yet, and a compose box that only appears
 * when signed in explains the connection better than a disabled button would.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { onAppEvent } from '../../src/common/app-events';
import { kvGet } from '../../src/common/kv';
import { getMutedWords } from '../../src/common/mute-state';
import {
  getSessionPrivateKey,
  restoreSessionPrivateKey,
} from '../../src/common/session';
import { setMutedWords } from '../../src/features/moderation/moderation-actions';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import { NotSignedInError, publishNote } from '../lib/publish';
import SignIn from './SignIn';

function readStoredPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

function Compose() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const send = useCallback(async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;

    setBusy(true);
    setNote('');
    try {
      const result = await publishNote(content);
      if (result.accepted.length === 0) {
        // Every relay refused or went quiet, so the note does not exist. The
        // text stays in the box: clearing it would throw away what was written.
        setNote(
          `No relay accepted it: ${result.rejected
            .map((r) => `${r.relay.replace('wss://', '')} (${r.reason})`)
            .join(', ')}`,
        );
        return;
      }
      setText('');
      setNote(
        `Posted to ${result.accepted.length} of ${
          result.accepted.length + result.rejected.length
        } relays.`,
      );
    } catch (e: any) {
      if (e instanceof NotSignedInError) {
        Alert.alert('Not signed in', 'There is no key in this session.');
      } else {
        setNote(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  }, [text]);

  return (
    <View style={styles.compose}>
      <Text style={styles.section}>Write a note</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="What's happening?"
        placeholderTextColor="#5b6b88"
        multiline
        style={styles.input}
      />
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <Pressable
        onPress={send}
        disabled={busy || text.trim().length === 0}
        style={[
          styles.button,
          (busy || text.trim().length === 0) && styles.buttonOff,
        ]}
      >
        {busy ? (
          <ActivityIndicator color="#0b1220" />
        ) : (
          <Text style={styles.buttonText}>Post</Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * The muted-word list.
 *
 * Every change publishes the whole kind:10000, words and people together,
 * because it is replaceable: sending the words alone would delete the muted
 * accounts, and sending the accounts alone would delete the words.
 */
function MutedWords() {
  const [words, setWords] = useState<string[]>(getMutedWords);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');

  /**
   * The published list arrives from the relays a moment after launch, and can
   * also change from a mute made on another screen. Without this the editor
   * shows whatever the cache held when it mounted, which is right until it
   * quietly is not.
   */
  useEffect(
    (): (() => void) =>
      onAppEvent('mute-list-updated', (): void => {
        setWords(getMutedWords());
      }),
    [],
  );

  const commit = useCallback(async (next: string[]): Promise<void> => {
    setNote('');
    try {
      await setMutedWords(next, getRelays());
    } catch {
      // The word is muted on this device either way. Saying nothing would
      // suggest the change did not take, which is the opposite of the truth.
      setNote('Muted here, but the list could not be published.');
    }
    setWords(getMutedWords());
  }, []);

  const add = useCallback((): void => {
    const word = draft.trim();
    if (!word) return;
    setDraft('');
    void commit([...getMutedWords(), word]);
  }, [draft, commit]);

  return (
    <View style={styles.compose}>
      <Text style={styles.section}>Muted words</Text>
      <Text style={styles.hint}>
        Posts whose text contains one of these are hidden. Whole words only, so
        muting "ass" will not hide "class". The list is private.
      </Text>
      <View style={styles.wordRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder="Add a word"
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
          style={[styles.input, styles.wordInput]}
        />
        <Pressable
          onPress={add}
          disabled={draft.trim().length === 0}
          style={[
            styles.button,
            styles.wordAdd,
            draft.trim().length === 0 && styles.buttonOff,
          ]}
        >
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {words.length === 0 ? (
        <Text style={styles.note}>No muted words.</Text>
      ) : (
        <View style={styles.chips}>
          {words.map((word: string) => (
            <Pressable
              key={word}
              onPress={(): void => {
                void commit(
                  getMutedWords().filter((w: string): boolean => w !== word),
                );
              }}
              style={styles.chip}
            >
              <Text style={styles.chipText}>{word}</Text>
              <Text style={styles.chipX}>×</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

export default function Account() {
  /**
   * Two different things, kept apart deliberately.
   *
   * `viewing` is the pubkey the timelines read from, which the Home tab sets
   * from a pasted npub and which needs no key at all. `canSign` is whether
   * this session actually holds a private key.
   *
   * Conflating them is how this screen first shipped, and on the phone it
   * announced "Signed in" over an npub it had no key for - with a Post button
   * that could only fail.
   */
  const [viewing, setViewing] = useState<PubkeyHex | null>(readStoredPubkey);
  const [canSign, setCanSign] = useState(false);
  const [ready, setReady] = useState(false);

  // The key lives in the credential store and cannot be read synchronously, so
  // the session is restored before anything tries to sign with it.
  useEffect(() => {
    void restoreSessionPrivateKey().then((): void => {
      setCanSign(getSessionPrivateKey() !== null);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen}>
      <SignIn
        signedInAs={canSign ? viewing : null}
        viewingAs={canSign ? null : viewing}
        onChange={(next: PubkeyHex | null): void => {
          setViewing(next);
          setCanSign(next !== null && getSessionPrivateKey() !== null);
        }}
      />
      {canSign ? <Compose /> : null}
      {canSign ? <MutedWords /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
  },
  compose: { paddingHorizontal: 24, paddingBottom: 32, gap: 10 },
  section: { color: '#f5f8ff', fontSize: 15, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
    minHeight: 96,
    textAlignVertical: 'top',
  },
  note: { color: '#8ea0c0', fontSize: 12 },
  hint: { color: '#5b6b88', fontSize: 12, lineHeight: 17 },
  wordRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  wordInput: { flex: 1, minHeight: 0, paddingVertical: 10 },
  wordAdd: { paddingHorizontal: 18, justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#25406e',
    backgroundColor: '#101a2e',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: '#e8eeff', fontSize: 13 },
  chipX: { color: '#8ea0c0', fontSize: 15, lineHeight: 15 },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
});

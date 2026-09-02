/**
 * Writing a note.
 *
 * A screen of its own, reached from the timeline, because that is where the
 * post is going. It used to sit under the account tab, which put "what do I
 * look like to other people" and "say something to them" in the same scroll.
 *
 * The text is not cleared until a relay has it. A note nobody stored is not a
 * note, and throwing away what somebody wrote because the network was having a
 * bad minute is the one failure there is no recovering from.
 *
 * A warning can be put on the note (NIP-36). The timeline has covered other
 * people's warned posts since the app was written; this is the other half,
 * so a post that needs one does not go out bare because the only place to
 * add it was the web.
 */

import { useNavigation } from '@react-navigation/native';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { emitAppEvent } from '../../src/common/app-events';
import { contentWarningTags } from '../../src/common/content-warning';
import { NotSignedInError, publishNote } from '../lib/publish';

export default function Compose() {
  const navigation = useNavigation();
  // The Post button is the last thing on the screen and sits above whatever
  // the system draws at the bottom. Fixed padding lost it under a
  // three-button navigation bar.
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [warned, setWarned] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const send = useCallback(async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;

    setBusy(true);
    setNote('');
    try {
      const result = await publishNote(content, {
        // The same tags the web composer writes, from the same function.
        tags: warned ? contentWarningTags(reason) : [],
      });
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
      setWarned(false);
      setReason('');
      // The timeline behind this screen shows the viewer's own posts, and
      // was loaded before this one existed.
      emitAppEvent('note-published');
      navigation.goBack();
    } catch (e: any) {
      if (e instanceof NotSignedInError) {
        Alert.alert('Not signed in', 'There is no key in this session.');
      } else {
        setNote(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  }, [text, warned, reason, navigation]);

  return (
    <View style={[styles.screen, { paddingBottom: 20 + insets.bottom }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="What's happening?"
        placeholderTextColor="#5b6b88"
        multiline
        autoFocus
        style={styles.input}
      />
      {/* The warning sits between the words and the button: decided after
          writing, before posting, the way it is read - as a line in front of
          the post. */}
      <View style={styles.warningRow}>
        <Text style={styles.warningLabel}>Content warning</Text>
        <Switch
          value={warned}
          onValueChange={setWarned}
          accessibilityLabel="Put a content warning on this post"
          trackColor={{ false: '#25406e', true: '#89a8ff' }}
          thumbColor={warned ? '#f5f8ff' : '#8ea0c0'}
        />
      </View>
      {warned ? (
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder="Reason (optional), e.g. spoilers"
          placeholderTextColor="#5b6b88"
          maxLength={80}
          style={styles.reason}
        />
      ) : null}
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
          <Text style={styles.buttonText}>
            {warned ? 'Post with warning' : 'Post'}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220', padding: 20, gap: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e8eeff',
    fontSize: 15,
    lineHeight: 21,
    backgroundColor: '#101a2e',
    textAlignVertical: 'top',
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  warningLabel: { color: '#b9c6de', fontSize: 14 },
  reason: {
    borderWidth: 1,
    borderColor: '#4a3a1a',
    backgroundColor: '#221a0d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffd79a',
    fontSize: 14,
  },
  note: { color: '#ff9a9a', fontSize: 12, lineHeight: 17 },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
});

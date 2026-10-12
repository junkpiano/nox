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

import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
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
import { quoteContent, quoteTags } from '../../src/common/quote';
import type { NostrEvent } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { NotSignedInError, publishNote } from '../lib/publish';
import { useKeyboardHeight } from '../lib/use-keyboard-height';

export default function Compose() {
  const navigation = useNavigation();
  // The Post button is the last thing on the screen and sits above whatever
  // the system draws at the bottom. Fixed padding lost it under a
  // three-button navigation bar.
  const insets = useSafeAreaInsets();
  // Edge to edge, the window does not shrink for the keyboard; the screen
  // pads itself by the keyboard's height and the field, being flexible,
  // takes what is left above it.
  const keyboard: number = useKeyboardHeight();
  // The post being quoted, when this was opened from a post's Quote.
  const route = useRoute<RouteProp<RootStackParamList, 'Compose'>>();
  const [quote, setQuote] = useState<NostrEvent | null>(
    route.params?.quote ?? null,
  );
  const [text, setText] = useState('');
  const [warned, setWarned] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const send = useCallback(async (): Promise<void> => {
    // A quote with no words of its own still says "this".
    if (!text.trim() && !quote) return;
    const content: string = quote ? quoteContent([text], quote) : text.trim();

    setBusy(true);
    setNote('');
    try {
      const result = await publishNote(content, {
        // The same tags the web composer writes, from the same function.
        tags: [
          ...(warned ? contentWarningTags(reason) : []),
          ...(quote ? quoteTags(quote) : []),
        ],
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
  }, [text, quote, warned, reason, navigation]);

  return (
    <View
      style={[
        styles.screen,
        { paddingBottom: keyboard > 0 ? keyboard + 12 : 20 + insets.bottom },
      ]}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="What's happening?"
        placeholderTextColor="#5b6b88"
        multiline
        autoFocus
        style={styles.input}
      />
      {quote ? (
        <View style={styles.quoteRow}>
          <Text style={styles.quoteLabel}>Quoting</Text>
          <Text style={styles.quoteText} numberOfLines={1}>
            {quote.content.replace(/\s+/g, ' ').trim()}
          </Text>
          <Pressable
            hitSlop={8}
            onPress={(): void => setQuote(null)}
            accessibilityLabel="Remove quote"
          >
            <Text style={styles.quoteRemove}>✕</Text>
          </Pressable>
        </View>
      ) : null}
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
        disabled={busy || (text.trim().length === 0 && !quote)}
        style={[
          styles.button,
          (busy || (text.trim().length === 0 && !quote)) && styles.buttonOff,
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
  quoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: '#25406e',
    borderLeftColor: '#89a8ff',
    borderRadius: 8,
  },
  quoteLabel: { color: '#bad0ff', fontWeight: '600', fontSize: 13 },
  quoteText: { flex: 1, color: '#9fb0d4', fontSize: 13 },
  quoteRemove: { color: '#7283aa', fontSize: 14 },
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

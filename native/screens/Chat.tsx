/**
 * One conversation.
 *
 * The list is inverted, which is how every messaging app on this platform
 * behaves and also the cheaper arrangement: new messages arrive at the anchored
 * end, so nothing has to be scrolled to keep the newest in view.
 *
 * A send reports where it went. NIP-17 asks the sender to publish to the
 * recipient's own DM relays (kind 10050), and when somebody has not published
 * that list there is nowhere correct to send - only this client's relays, as a
 * guess. That is the difference between "sent" and "sent somewhere they may
 * never look", and the person sending it is the one who needs to know.
 */

import type { RouteProp } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { onAppEvent } from '../../src/common/app-events';
import { kvGet } from '../../src/common/kv';
import type { StoredMessage } from '../../src/features/messages/messages-store';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { readConversation, send } from '../lib/messages';

type ChatRoute = RouteProp<RootStackParamList, 'Chat'>;

function viewerPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

function timeLabel(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Chat({ route }: { route: ChatRoute }) {
  const { peer } = route.params;
  const viewer = viewerPubkey();

  const [messages, setMessages] = useState<StoredMessage[]>(() =>
    readConversation(peer),
  );
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');

  const refresh = useCallback((): void => {
    setMessages(readConversation(peer));
  }, [peer]);

  useEffect(
    (): (() => void) => onAppEvent('dm-messages-updated', refresh),
    [refresh],
  );

  const submit = (): void => {
    const content = draft.trim();
    if (!content || !viewer) return;

    setSending(true);
    setNote('');
    // Cleared straight away: the store records the outgoing message before
    // publishing, so it is already on screen by the time this resolves.
    setDraft('');
    void send(viewer, peer, content)
      .then((result): void => {
        setNote(
          result.deliveredToRecipientRelays
            ? ''
            : result.usedFallback
              ? 'They have not published a DM relay list, so this went to the ' +
                'relays they read from. They may not see it.'
              : 'They have not published a DM relay list, so this went to your ' +
                'own relays. They may never look there.',
        );
      })
      .catch((error: unknown): void => {
        setNote(`Not sent: ${String((error as Error)?.message ?? error)}`);
        // Put the text back rather than losing it.
        setDraft(content);
      })
      .finally((): void => setSending(false));
  };

  const ordered: StoredMessage[] = messages
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Outside the list, not as its empty component. An inverted list draws
          its children through a flipped transform, so anything handed to it
          arrives upside down - and the exact flip is a platform detail, which
          makes cancelling it a guess rather than a fix. */}
      {ordered.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.empty}>
            Nothing here yet. A message you send is sealed to them and to nobody
            else, including the relays that carry it.
          </Text>
        </View>
      ) : null}

      <FlatList
        inverted
        data={ordered}
        keyExtractor={(message: StoredMessage) => message.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }: { item: StoredMessage }) => {
          const mine = item.author === viewer;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                <Text style={mine ? styles.mineText : styles.theirsText}>
                  {item.content}
                </Text>
                <Text style={mine ? styles.mineMeta : styles.theirsMeta}>
                  {timeLabel(item.createdAt)}
                </Text>
              </View>
            </View>
          );
        }}
      />

      {note ? <Text style={styles.note}>{note}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor="#5b6b88"
          multiline
          style={styles.input}
        />
        <Pressable
          onPress={submit}
          disabled={sending || draft.trim().length === 0}
          style={[
            styles.sendButton,
            (sending || draft.trim().length === 0) && styles.off,
          ]}
        >
          {sending ? (
            <ActivityIndicator color="#0b1220" />
          ) : (
            <Text style={styles.sendText}>Send</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  list: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  mine: { backgroundColor: '#89a8ff' },
  theirs: { backgroundColor: '#16233f' },
  mineText: { color: '#0b1220', fontSize: 14, lineHeight: 19 },
  theirsText: { color: '#e8eeff', fontSize: 14, lineHeight: 19 },
  mineMeta: {
    color: 'rgba(11,18,32,0.55)',
    fontSize: 10,
    marginTop: 3,
    alignSelf: 'flex-end',
  },
  theirsMeta: { color: '#5b6b88', fontSize: 10, marginTop: 3 },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  empty: {
    color: '#8ea0c0',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  note: {
    color: '#ffd79a',
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  composer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#25406e',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: '#89a8ff',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 11,
    justifyContent: 'center',
  },
  sendText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  off: { opacity: 0.4 },
});

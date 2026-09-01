/**
 * The conversation list.
 *
 * A gift wrap says nothing about who is inside it, so there is no filter for
 * "conversations with X" - the only question a relay can answer is "wraps
 * addressed to me", and everything else is found by decrypting. That is why
 * this screen shows what the cache already holds and lets the sync loop fill
 * it in behind, rather than fetching on open.
 */

import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { onAppEvent } from '../../src/common/app-events';
import { kvGet } from '../../src/common/kv';
import { getSessionPrivateKey } from '../../src/common/session';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import type { ConversationRow } from '../lib/messages';
import { loadConversations, resolveRecipient } from '../lib/messages';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function viewerPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default function Messages() {
  const navigation = useNavigation<Nav>();
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');

  const canSign = getSessionPrivateKey() !== null;
  const viewer = viewerPubkey();

  const refresh = useCallback((): void => {
    void loadConversations()
      .then(setRows)
      .catch((error: unknown): void => {
        console.warn('[dm] Could not read conversations:', error);
        setRows([]);
      });
  }, []);

  // Reloaded on focus as well as on change: a message that arrived while this
  // tab was in the background has already updated the store, and nothing would
  // otherwise tell this screen about it.
  useFocusEffect(refresh);

  useEffect(
    (): (() => void) => onAppEvent('dm-messages-updated', refresh),
    [refresh],
  );

  const open = (peer: PubkeyHex, name: string): void => {
    navigation.navigate('Chat', { peer, name });
  };

  const start = (): void => {
    const input = draft.trim();
    if (!input) return;
    setResolving(true);
    setNote('');
    void resolveRecipient(input)
      .then((peer: PubkeyHex): void => {
        setDraft('');
        open(peer, `${peer.slice(0, 8)}...`);
      })
      .catch((error: unknown): void => {
        setNote(String((error as Error)?.message ?? error));
      })
      .finally((): void => setResolving(false));
  };

  if (!viewer || !canSign) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          Private messages need a key on this phone. A pasted npub can read a
          timeline, but nothing can open a gift wrap without the key it was
          sealed to.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.compose}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={start}
          placeholder="npub, nprofile or name@domain"
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Pressable
          onPress={start}
          disabled={resolving || draft.trim().length === 0}
          style={[
            styles.newButton,
            (resolving || draft.trim().length === 0) && styles.off,
          ]}
        >
          <Text style={styles.newButtonText}>
            {resolving ? '...' : 'Write'}
          </Text>
        </Pressable>
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}

      {rows === null ? (
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.centre}>
          <Text style={styles.empty}>
            No conversations yet. Messages sent to you arrive here as they are
            unwrapped.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row: ConversationRow) => row.peer}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }: { item: ConversationRow }) => (
            <Pressable
              onPress={() => open(item.peer, item.name)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              {item.picture ? (
                <Image source={{ uri: item.picture }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarBlank]} />
              )}
              <View style={styles.rowBody}>
                <View style={styles.rowHead}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.meta}>{timeAgo(item.createdAt)}</Text>
                </View>
                <Text style={styles.preview} numberOfLines={2}>
                  {item.preview}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  compose: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#25406e',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
  },
  newButton: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  newButtonText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  off: { opacity: 0.4 },
  note: {
    color: '#ff9a9a',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  pressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#25406e',
  },
  avatarBlank: { opacity: 0.5 },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: '#e8eeff', fontWeight: '700', fontSize: 15, flex: 1 },
  meta: { color: '#5b6b88', fontSize: 11 },
  preview: { color: '#8ea0c0', fontSize: 13, lineHeight: 18, marginTop: 3 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: {
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
});

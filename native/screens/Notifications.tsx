/**
 * Reactions, reposts and replies addressed to you.
 *
 * A reaction's content is whatever the sender put there - usually "+" or an
 * emoji, occasionally a paragraph. NIP-25 says "+" means a like, so it is
 * shown as one rather than as a plus sign.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { PubkeyHex } from '../../types/nostr';
import { kvGet } from '../../src/common/kv';
import type { RootStackParamList } from '../App';
import { loadNotifications, type Notification } from '../lib/notifications';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** A reaction body is a stranger's string; one glyph of it is plenty. */
const MAX_REACTION_GLYPHS: number = 3;

function readViewer(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

function summarise(item: Notification): string {
  if (item.kind === 'repost') return 'reposted you';
  if (item.kind === 'reply') return 'replied';
  // NIP-25: "+" is a like and "-" a dislike; anything else is shown as sent.
  const body = item.content.trim();
  if (body === '+' || body === '') return 'liked your post';
  if (body === '-') return 'disliked your post';
  return `reacted ${Array.from(body).slice(0, MAX_REACTION_GLYPHS).join('')}`;
}

export default function Notifications() {
  const [viewer] = useState<PubkeyHex | null>(readViewer);
  const [items, setItems] = useState<Notification[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navigation = useNavigation<Nav>();

  const load = useCallback(async (): Promise<void> => {
    if (!viewer) return;
    try {
      const result = await loadNotifications(viewer, setStage);
      setItems(result.notifications);
      setStats(
        `${result.stats.events} from others / ${result.stats.relays} relays / ` +
          `${(result.stats.ms / 1000).toFixed(1)}s`,
      );
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!viewer) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          Set an npub on the Home tab and this fills in.
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
        <Text style={styles.empty}>{stage || 'loading...'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {stats ? <Text style={styles.stats}>{stats}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(item: Notification) => item.id}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#89a8ff"
            colors={['#89a8ff']}
            progressBackgroundColor="#16233f"
          />
        }
        renderItem={({ item }: { item: Notification }) => (
          <Pressable
            onPress={() => {
              if (item.targetId) {
                navigation.navigate('Thread', { eventId: item.targetId });
              } else {
                navigation.navigate('Profile', { pubkey: item.pubkey });
              }
            }}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Pressable
              onPress={() =>
                navigation.navigate('Profile', { pubkey: item.pubkey })
              }
              hitSlop={6}
            >
              {item.picture ? (
                <Image source={{ uri: item.picture }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarBlank]} />
              )}
            </Pressable>
            <View style={styles.rowBody}>
              <Text style={styles.line} numberOfLines={1}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.verb}> {summarise(item)}</Text>
              </Text>
              {item.kind === 'reply' && item.content ? (
                <Text style={styles.body} numberOfLines={3}>
                  {item.content}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  stats: {
    color: '#5b6b88',
    fontSize: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowPressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#25406e' },
  avatarBlank: { opacity: 0.5 },
  rowBody: { flex: 1 },
  line: { fontSize: 14 },
  name: { color: '#e8eeff', fontWeight: '700' },
  verb: { color: '#8ea0c0' },
  body: { color: '#b9c6de', fontSize: 13, lineHeight: 19, marginTop: 4 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    backgroundColor: '#0b1220',
  },
  empty: { color: '#5b6b88', fontSize: 13, textAlign: 'center' },
  error: { color: '#ff9a9a', fontSize: 13, textAlign: 'center' },
});

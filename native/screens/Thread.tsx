/**
 * One post and its replies.
 *
 * This screen is almost entirely shared code: `fetchEventById`,
 * `fetchRepliesForEvent` and `isEventDeleted` all come from the web app's
 * events-queries.ts, unchanged. What is written here is the arrangement.
 *
 * Deletion is checked rather than assumed. NIP-09 is a request, not an
 * erasure - the event is still on relays that chose to keep it - and a client
 * that ignores the request shows people something they asked to withdraw.
 */

import { useEffect, useState } from 'react';
import type { RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import {
  fetchEventById,
  fetchRepliesForEvent,
  isEventDeleted,
} from '../../src/common/events-queries';
import { getRelays } from '../../src/features/relays/relays';
import type { RootStackParamList } from '../App';

type ThreadRoute = RouteProp<RootStackParamList, 'Thread'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

interface ThreadData {
  root: NostrEvent | null;
  deleted: boolean;
  replies: NostrEvent[];
}

function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Thread({ route }: { route: ThreadRoute }) {
  const { eventId } = route.params;
  const [data, setData] = useState<ThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigation = useNavigation<Nav>();

  useEffect(() => {
    let cancelled = false;
    const relays = getRelays();

    (async (): Promise<void> => {
      try {
        const root = await fetchEventById(eventId, relays);
        if (cancelled) return;
        if (!root) {
          setData({ root: null, deleted: false, replies: [] });
          return;
        }

        // Replies and the deletion check run together: neither depends on the
        // other, and the thread is not readable until both have answered.
        const [deleted, replies] = await Promise.all([
          isEventDeleted(root.id, root.pubkey as PubkeyHex, relays),
          fetchRepliesForEvent(root.id, relays),
        ]);
        if (cancelled) return;

        setData({
          root,
          deleted,
          replies: replies.sort(
            (a: NostrEvent, b: NostrEvent): number => a.created_at - b.created_at,
          ),
        });
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (error) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  if (!data.root) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          None of your relays has this event. It may exist elsewhere.
        </Text>
      </View>
    );
  }

  const root: NostrEvent = data.root;

  return (
    <FlatList
      style={styles.screen}
      data={data.replies}
      keyExtractor={(event: NostrEvent) => event.id}
      ListHeaderComponent={
        <View>
          <Pressable
            onPress={() =>
              navigation.navigate('Profile', { pubkey: root.pubkey as PubkeyHex })
            }
            style={styles.rootPost}
          >
            <Text style={styles.meta}>{timeAgo(root.created_at)}</Text>
            {data.deleted ? (
              <Text style={styles.deleted}>
                The author asked for this to be deleted.
              </Text>
            ) : (
              <Text style={styles.rootContent}>{root.content}</Text>
            )}
          </Pressable>
          <Text style={styles.replyHeading}>
            {data.replies.length === 0
              ? 'No replies'
              : `${data.replies.length} ${data.replies.length === 1 ? 'reply' : 'replies'}`}
          </Text>
        </View>
      }
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      renderItem={({ item }: { item: NostrEvent }) => (
        <Pressable
          onPress={() => navigation.push('Thread', { eventId: item.id })}
          style={({ pressed }) => [styles.reply, pressed && styles.replyPressed]}
        >
          <Text style={styles.meta}>{timeAgo(item.created_at)}</Text>
          <Text style={styles.replyContent} numberOfLines={12}>
            {item.content}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  rootPost: { padding: 16 },
  rootContent: { color: '#e8eeff', fontSize: 16, lineHeight: 23, marginTop: 6 },
  deleted: {
    color: '#8ea0c0',
    fontSize: 14,
    fontStyle: 'italic',
    marginTop: 6,
  },
  meta: { color: '#5b6b88', fontSize: 11 },
  replyHeading: {
    color: '#8ea0c0',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#101a2e',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(148,163,184,0.14)',
  },
  reply: { paddingHorizontal: 16, paddingVertical: 14 },
  replyPressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
  replyContent: { color: '#b9c6de', fontSize: 14, lineHeight: 20, marginTop: 4 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
    padding: 24,
  },
  error: { color: '#ff9a9a', fontSize: 13 },
  empty: { color: '#5b6b88', fontSize: 13, textAlign: 'center' },
});

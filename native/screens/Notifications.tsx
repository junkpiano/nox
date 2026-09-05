/**
 * Reactions, reposts and replies addressed to you.
 *
 * A reaction's content is whatever the sender put there - usually "+" or an
 * emoji, occasionally a paragraph. NIP-25 says "+" means a like, so it is
 * shown as one rather than as a plus sign.
 *
 * All, or only the people you follow. The switch is the same one Home has,
 * the judgement is the shared filter's: a follow list nobody could read
 * shows everything and says so, and following nobody is its own empty
 * page, not a broken one.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { kvGet } from '../../src/common/kv';
import {
  type NotificationScope,
  readNotificationScope,
  type ScopedNotifications,
  saveNotificationScope,
  scopeNotifications,
} from '../../src/common/notification-filter';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
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

/** What the empty list should say, which depends on what was asked for. */
function emptyText(scoped: ScopedNotifications<Notification>): string {
  if (scoped.scope === 'following') {
    return scoped.followCount === 0
      ? 'You do not follow anyone yet.'
      : 'No notifications from people you follow.';
  }
  return 'No notifications yet.';
}

export default function Notifications() {
  const [viewer] = useState<PubkeyHex | null>(readViewer);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [scope, setScope] = useState<NotificationScope>(readNotificationScope);
  const [scoped, setScoped] =
    useState<ScopedNotifications<Notification> | null>(null);
  const [scoping, setScoping] = useState(false);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navigation = useNavigation<Nav>();
  // Only the newest ask may draw: Following waits on a relay round trip,
  // and a tap back to All in that time must not be overwritten by it.
  const generation = useRef(0);

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

  // The scope is applied to what was loaded, and again whenever either
  // changes. The choice is kept on this device.
  useEffect((): (() => void) => {
    let cancelled = false;
    if (!viewer || !items) {
      return (): void => {
        cancelled = true;
      };
    }
    generation.current += 1;
    const mine: number = generation.current;
    saveNotificationScope(scope);
    setScoping(scope === 'following');
    void scopeNotifications(scope, viewer, items, getRelays()).then(
      (next): void => {
        if (cancelled || mine !== generation.current) return;
        setScoped(next);
        setScoping(false);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [viewer, items, scope]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!viewer) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          Sign in, or browse as a public key, and this fills in.
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

  const switcher = (
    <View style={styles.switcher}>
      {(['all', 'following'] as NotificationScope[]).map(
        (option: NotificationScope) => {
          const on: boolean = option === scope;
          return (
            <Pressable
              key={option}
              onPress={(): void => setScope(option)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.segment, on && styles.segmentOn]}
            >
              <Text style={on ? styles.segmentTextOn : styles.segmentText}>
                {option === 'all' ? 'All' : 'Following'}
              </Text>
            </Pressable>
          );
        },
      )}
    </View>
  );

  if (!items || !scoped) {
    return (
      <View style={styles.screen}>
        {switcher}
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
          <Text style={styles.empty}>
            {!items ? stage || 'loading...' : 'Reading your follow list...'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {switcher}
      {scoped.scope === 'following-unavailable' ? (
        <Text style={styles.notice}>
          Your follow list could not be read, so everything is shown.
        </Text>
      ) : null}
      {stats ? <Text style={styles.stats}>{stats}</Text> : null}
      <FlatList
        data={scoped.events}
        keyExtractor={(item: Notification) => item.id}
        extraData={scoping}
        style={scoping && styles.dim}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={
          <View style={styles.centre}>
            <Text style={styles.empty}>{emptyText(scoped)}</Text>
          </View>
        }
        contentContainerStyle={scoped.events.length === 0 && styles.grow}
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
  // The same switch Home has, so the two say "this list is filtered" the
  // same way.
  switcher: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#25406e',
  },
  segment: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 999,
    paddingVertical: 8,
    alignItems: 'center',
  },
  segmentOn: { borderColor: '#89a8ff', backgroundColor: '#16233f' },
  segmentText: { color: '#8ea0c0', fontSize: 13, fontWeight: '600' },
  segmentTextOn: { color: '#e8eeff', fontSize: 13, fontWeight: '700' },
  notice: {
    color: '#8ea0c0',
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  dim: { opacity: 0.5 },
  grow: { flexGrow: 1 },
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
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#25406e',
  },
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

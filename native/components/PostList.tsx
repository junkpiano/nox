/**
 * The list both timelines draw.
 *
 * Home and Global differ only in which events they ask for, so they share the
 * list rather than each keeping their own copy of it - the same reasoning that
 * keeps the protocol layer shared with the web app, applied one level up.
 *
 * The HUD reports how many rows are actually mounted against the total. It is
 * the one claim about React Native a screenshot can settle: the web build
 * holds every card in the DOM, and this does not.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { contentWarningSummary } from '../../src/common/content-warning';
import { getSessionPrivateKey } from '../../src/common/session';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import type { TimelinePost } from '../lib/home-timeline';
import { likeEvent, NotSignedInError, repostEvent } from '../lib/interact';
import PostBody from './PostBody';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Live count of mounted rows, shared by whichever list is on screen. */
let mountedRows = 0;
const listeners = new Set<(n: number) => void>();
function bumpMounted(delta: number): void {
  mountedRows += delta;
  for (const listener of listeners) listener(mountedRows);
}

function useMountedRows(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    listeners.add(setN);
    return () => {
      listeners.delete(setN);
    };
  }, []);
  return n;
}

function Row({
  post,
  onOpenThread,
  onOpenProfile,
}: {
  post: TimelinePost;
  onOpenThread: () => void;
  onOpenProfile: () => void;
}) {
  /**
   * NIP-36: the author asked for this not to be shown unasked.
   *
   * Revealing is per row and not remembered. A warning is about one post, and
   * carrying the decision to the next one would answer a question nobody was
   * asked.
   */
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    bumpMounted(1);
    return () => bumpMounted(-1);
  }, []);

  return (
    <Pressable
      onPress={onOpenThread}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {/* The avatar and name go to the person; the rest of the row goes to the
          post. Tapping a face and landing on a thread is the kind of small
          wrongness that reads as an app not knowing what it is. */}
      <Pressable onPress={onOpenProfile} hitSlop={6}>
        {post.picture ? (
          <Image source={{ uri: post.picture }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarBlank]} />
        )}
      </Pressable>
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.name} numberOfLines={1} onPress={onOpenProfile}>
            {post.name}
          </Text>
          {post.kind === 6 ? <Text style={styles.badge}>repost</Text> : null}
        </View>
        {post.nip05 ? (
          <Text style={styles.nip05} numberOfLines={1}>
            {post.nip05}
          </Text>
        ) : null}
        {post.warning.hasWarning && !revealed ? (
          <Pressable
            onPress={(): void => setRevealed(true)}
            style={styles.warning}
          >
            <Text style={styles.warningText}>
              ⚠️ {contentWarningSummary(post.warning)}
            </Text>
            <Text style={styles.warningHint}>Tap to show</Text>
          </Pressable>
        ) : (
          <PostBody
            content={post.content}
            textStyle={styles.content}
            linkStyle={styles.link}
            numberOfLines={12}
          />
        )}
        <Actions post={post} />
      </View>
    </Pressable>
  );
}

/**
 * Like, repost and reply, on the card.
 *
 * They were only on the thread screen, which meant the two things people do
 * most needed a screen change first. Reply still opens the thread, because a
 * reply wants to be written where the conversation is - it just opens with the
 * box already up rather than making you find it.
 *
 * Marked done only once a relay has it. A like nobody stored is not a like.
 */
function Actions({ post }: { post: TimelinePost }) {
  const navigation = useNavigation<Nav>();
  const [liked, setLiked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [busy, setBusy] = useState<'like' | 'repost' | null>(null);

  if (!getSessionPrivateKey()) {
    return null;
  }

  const run = (
    what: 'like' | 'repost',
    action: () => Promise<{ accepted: string[] }>,
    done: () => void,
  ): void => {
    setBusy(what);
    void action()
      .then((result): void => {
        if (result.accepted.length > 0) {
          done();
        } else {
          Alert.alert(`Could not ${what}`, 'No relay accepted it.');
        }
      })
      .catch((error: unknown): void => {
        if (error instanceof NotSignedInError) {
          Alert.alert('Not signed in', 'There is no key in this session.');
        } else {
          Alert.alert(
            `Could not ${what}`,
            String((error as Error)?.message ?? error),
          );
        }
      })
      .finally((): void => setBusy(null));
  };

  return (
    <View style={styles.actions}>
      <Pressable
        hitSlop={8}
        disabled={liked || busy !== null}
        onPress={(): void =>
          run(
            'like',
            () => likeEvent(post.event),
            () => setLiked(true),
          )
        }
      >
        <Text style={liked ? styles.actionOn : styles.action}>
          {busy === 'like' ? '···' : liked ? '♥ Liked' : '♡ Like'}
        </Text>
      </Pressable>
      <Pressable
        hitSlop={8}
        disabled={reposted || busy !== null}
        onPress={(): void =>
          run(
            'repost',
            () => repostEvent(post.event),
            () => setReposted(true),
          )
        }
      >
        <Text style={reposted ? styles.actionOn : styles.action}>
          {busy === 'repost' ? '···' : reposted ? '⇄ Reposted' : '⇄ Repost'}
        </Text>
      </Pressable>
      <Pressable
        hitSlop={8}
        onPress={(): void =>
          navigation.navigate('Thread', { eventId: post.id, reply: true })
        }
      >
        <Text style={styles.action}>↩ Reply</Text>
      </Pressable>
    </View>
  );
}

export interface PostListProps {
  posts: TimelinePost[];
  stats: string;
  stage: string;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}

export default function PostList({
  posts,
  stats,
  stage,
  error,
  refreshing,
  onRefresh,
}: PostListProps) {
  const live = useMountedRows();
  const [offset, setOffset] = useState(0);
  const navigation = useNavigation<Nav>();

  return (
    <View style={styles.screen}>
      <View style={styles.hud}>
        <Text style={styles.hudText}>
          mounted <Text style={styles.hudNum}>{live}</Text> / {posts.length}
        </Text>
        <Text style={styles.hudText}>y {Math.round(offset)}</Text>
      </View>
      {stats ? <Text style={styles.stats}>{stats}</Text> : null}

      {error ? (
        <View style={styles.centre}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : posts.length === 0 ? (
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
          <Text style={styles.stage}>{stage || 'loading...'}</Text>
        </View>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(p: TimelinePost) => p.id}
          renderItem={({ item }: { item: TimelinePost }) => (
            <Row
              post={item}
              onOpenThread={() =>
                navigation.navigate('Thread', { eventId: item.id })
              }
              onOpenProfile={() =>
                navigation.navigate('Profile', {
                  pubkey: item.pubkey as PubkeyHex,
                })
              }
            />
          )}
          onScroll={(e) => setOffset(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
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
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  hud: {
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#16233f',
    borderBottomWidth: 1,
    borderBottomColor: '#25406e',
  },
  hudText: { color: '#8ea0c0', fontSize: 12 },
  hudNum: { color: '#73f0c1', fontWeight: '700' },
  stats: {
    color: '#5b6b88',
    fontSize: 10,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowPressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#25406e',
  },
  avatarBlank: { opacity: 0.5 },
  rowBody: { flex: 1 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: '#e8eeff', fontWeight: '700', fontSize: 14, flexShrink: 1 },
  badge: {
    color: '#73f0c1',
    fontSize: 10,
    borderWidth: 1,
    borderColor: '#25563f',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  nip05: { color: '#5b6b88', fontSize: 11, marginTop: 1 },
  content: { color: '#b9c6de', fontSize: 14, lineHeight: 20, marginTop: 5 },
  link: { color: '#89a8ff' },
  actions: { flexDirection: 'row', gap: 20, marginTop: 10 },
  action: { color: '#5b6b88', fontSize: 12, fontWeight: '600' },
  actionOn: { color: '#73f0c1', fontSize: 12, fontWeight: '700' },
  warning: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#4a3a1a',
    backgroundColor: '#221a0d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warningText: { color: '#ffd79a', fontSize: 13, lineHeight: 18 },
  warningHint: { color: '#8a7550', fontSize: 11, marginTop: 4 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stage: { color: '#8ea0c0', fontSize: 13 },
  error: { color: '#ff9a9a', fontSize: 13, paddingHorizontal: 24 },
});

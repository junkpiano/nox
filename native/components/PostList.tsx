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
import PostMenu from './PostMenu';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function PostRow({
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

  /*
   * The row is not one big button.
   *
   * It was, and the picture inside it could not be tapped: a Pressable inside
   * a Pressable does not reliably win the touch, so tapping an image opened
   * the thread instead of the picture. Each part now owns its own target -
   * the face and the name go to the person, the words go to the thread, the
   * picture opens itself, and the actions act.
   */
  return (
    <View style={styles.row}>
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
          {post.repostedBy ? (
            <Text style={styles.badge} numberOfLines={1}>
              ⇄ {post.repostedBy.name}
            </Text>
          ) : null}
          <Text style={styles.time}>{timeAgo(post.createdAt)}</Text>
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
            onPressText={onOpenThread}
          />
        )}
        <Actions post={post} />
      </View>
    </View>
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
  const [menuOpen, setMenuOpen] = useState(false);

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
      <PostMenu
        post={post}
        visible={menuOpen}
        onClose={(): void => setMenuOpen(false)}
      />
      <Pressable
        hitSlop={8}
        onPress={(): void =>
          navigation.push('Thread', { eventId: post.id, reply: true })
        }
      >
        <Text accessibilityLabel="Reply" style={styles.action}>
          ↩
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
        <Text
          accessibilityLabel="Repost"
          style={reposted ? styles.actionOn : styles.action}
        >
          {busy === 'repost' ? '···' : '⇄'}
        </Text>
      </Pressable>
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
        <Text
          accessibilityLabel="Like"
          style={liked ? styles.actionOn : styles.action}
        >
          {busy === 'like' ? '···' : liked ? '♥' : '♡'}
        </Text>
      </Pressable>
      {/* The rare and consequential things, one step further in. Deleting is
          irreversible and used to sit a stray tap from reply. */}
      <Pressable hitSlop={8} onPress={(): void => setMenuOpen(true)}>
        <Text accessibilityLabel="More" style={styles.action}>
          ⋯
        </Text>
      </Pressable>
    </View>
  );
}

/** How long ago, in the shape every timeline uses. */
function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(createdAt * 1000).toLocaleDateString();
}

export interface PostListProps {
  posts: TimelinePost[];
  /**
   * Kept in the props and no longer drawn.
   *
   * "1036 events / 281 profiles / 4 relays / 5.7s" over a timeline, and a
   * live count of mounted rows above that, were how the prototype proved
   * virtualisation was real. They are instrumentation, and they had no
   * business still being on the screen of an app somebody uses.
   */
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
  const navigation = useNavigation<Nav>();

  return (
    <View style={styles.screen}>
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
          keyExtractor={(p: TimelinePost) => p.key}
          renderItem={({ item }: { item: TimelinePost }) => (
            <PostRow
              post={item}
              onOpenThread={() =>
                navigation.push('Thread', { eventId: item.id })
              }
              onOpenProfile={() =>
                navigation.push('Profile', {
                  pubkey: item.pubkey as PubkeyHex,
                })
              }
            />
          )}
          // Room for the compose button to sit over, so the last card can be
          // scrolled out from under it rather than staying half-covered.
          contentContainerStyle={styles.listContent}
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
  time: { color: '#5b6b88', fontSize: 11, marginLeft: 'auto' },
  content: { color: '#b9c6de', fontSize: 14, lineHeight: 20, marginTop: 5 },
  link: { color: '#89a8ff' },
  actions: { flexDirection: 'row', gap: 28, marginTop: 10 },
  action: { color: '#5b6b88', fontSize: 17 },
  actionOn: { color: '#73f0c1', fontSize: 17 },
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
  listContent: { paddingBottom: 96 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stage: { color: '#8ea0c0', fontSize: 13 },
  error: { color: '#ff9a9a', fontSize: 13, paddingHorizontal: 24 },
});

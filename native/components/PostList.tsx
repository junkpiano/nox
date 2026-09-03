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
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type FlatListProps,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { contentWarningSummary } from '../../src/common/content-warning';
import { newPostsLabel } from '../../src/common/new-posts';
import { getSessionPrivateKey } from '../../src/common/session';
import type { UserStatus } from '../../src/features/profile/user-status';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { customEmojiOf } from '../lib/avatar';
import type { TimelinePost } from '../lib/home-timeline';
import { likeEvent, NotSignedInError, repostEvent } from '../lib/interact';
import { useSessionVersion } from '../lib/use-session-version';
import { useUserStatuses } from '../lib/use-user-statuses';
import PostBody from './PostBody';
import PostMenu from './PostMenu';
import QuoteCard from './QuoteCard';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function PostRow({
  post,
  status = null,
  onOpenThread,
  onOpenProfile,
}: {
  post: TimelinePost;
  /** NIP-38: what the author says they are up to, when they said. */
  status?: UserStatus | null;
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
          <Text style={styles.time} numberOfLines={1}>
            {timeAgo(post.createdAt)}
            {post.client ? ` · ${post.client}` : ''}
          </Text>
        </View>
        {post.nip05 ? (
          <Text style={styles.nip05} numberOfLines={1}>
            {post.nip05}
          </Text>
        ) : null}
        {status ? (
          <Text style={styles.status} numberOfLines={1}>
            {status.text}
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
            emoji={customEmojiOf(post.event.tags)}
          />
        )}
        {post.repostTargetId ? (
          <QuoteCard eventId={post.repostTargetId} />
        ) : null}
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

/**
 * The row that says new posts are waiting.
 *
 * A row, not a banner: it sits between the header and the first post,
 * thinner and quieter than a card, and scrolls away with the list. Nothing
 * is added to the list until it is tapped, so the words somebody is reading
 * stay where they are.
 */
function NewPostsRow({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.newRow, pressed && styles.newRowPressed]}
    >
      <View style={styles.newRule} />
      <Text style={styles.newText}>{newPostsLabel(count)}</Text>
      <View style={styles.newRule} />
    </Pressable>
  );
}

/**
 * The list props that ask for older posts.
 *
 * `onEndReached` alone is not enough. The list reports its end only from a
 * scroll, a layout or a content-size change, and only once per content
 * length; a report made while a page was still loading is the last one at
 * that length, and cells that render later do not report at all. After a
 * fast fling that was every time: the page arrived, the list sat at its
 * end, and nothing asked for the next one. So the end of a fling or a drag
 * reads the scroll metrics itself and asks as well. Asking is idempotent -
 * one request at a time, whatever the count of askers.
 */
export function olderPostsListProps(
  older: OlderPostsState | undefined,
): Partial<FlatListProps<TimelinePost>> {
  if (!older) return {};
  // Within about a screen of the end.
  const nearEnd = (event: NativeSyntheticEvent<NativeScrollEvent>): boolean => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    return contentOffset.y + layoutMeasurement.height * 2 >= contentSize.height;
  };
  return {
    onEndReached: (): void => older.loadOlder(),
    onEndReachedThreshold: 1,
    onMomentumScrollEnd: (event): void => {
      if (nearEnd(event)) older.loadOlder();
    },
    onScrollEndDrag: (event): void => {
      if (nearEnd(event)) older.loadOlder();
    },
  };
}

/**
 * The last row of a timeline that reads further back.
 *
 * A row in the list, not something over it. It says what the reading is
 * doing so an end that is merely slow is not mistaken for the end, and an
 * error leaves the posts above it alone and offers another try.
 */
export function TimelineFooter({
  state,
  hasPosts,
}: {
  state: OlderPostsState;
  hasPosts: boolean;
}) {
  if (!hasPosts) return null;
  if (state.loadingOlder) {
    return (
      <View style={styles.footer}>
        <ActivityIndicator color="#89a8ff" />
        <Text style={styles.footerText}>Loading older posts…</Text>
      </View>
    );
  }
  if (state.loadOlderError) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerText}>Could not load older posts</Text>
        <Pressable
          onPress={(): void => state.loadOlder()}
          hitSlop={8}
          style={styles.footerButton}
        >
          <Text style={styles.footerButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!state.hasMore) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {state.atCap ? 'Display limit reached' : 'No older posts'}
        </Text>
      </View>
    );
  }
  return null;
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
   * True while a load is in flight. Without this, an empty result was
   * indistinguishable from a load that had not finished: the spinner and
   * the last stage text stayed up forever over a timeline that had
   * simply come back with nothing.
   */
  loading: boolean;
  /** What to say when the load finished and there is nothing to show. */
  emptyMessage: string;
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
  /**
   * Posts that arrived since the list was drawn and are waiting to be let
   * in. When there are any, a thin row at the top of the list says how many;
   * it scrolls with the list like any other row rather than floating over
   * it, and a tap calls `onShowNew`.
   */
  pendingCount?: number;
  onShowNew?: () => void;
  /**
   * Reading further back. When given, nearing the end of the list asks for
   * the page before it, and the last row says what is happening: loading,
   * failed with a retry, or nothing older. Absent for lists that end.
   */
  older?: OlderPostsState;
}

export interface OlderPostsState {
  loadingOlder: boolean;
  hasMore: boolean;
  loadOlderError: string | null;
  atCap: boolean;
  loadOlder: () => void;
}

export default function PostList({
  posts,
  stats,
  stage,
  error,
  refreshing,
  onRefresh,
  loading,
  emptyMessage,
  pendingCount = 0,
  onShowNew,
  older,
}: PostListProps) {
  const navigation = useNavigation<Nav>();
  // Rows decide whether to draw their action row from the session key, and
  // FlatList only re-renders rows when the data or this changes.
  const sessionVersion = useSessionVersion();
  const statuses = useUserStatuses(posts);
  const list = useRef<FlatList<TimelinePost>>(null);

  const showNew = (): void => {
    onShowNew?.();
    // The new posts go in at the top; the reader goes there with them.
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };

  return (
    <View style={styles.screen}>
      {error ? (
        <View style={styles.centre}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : posts.length === 0 && loading ? (
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
          <Text style={styles.stage}>{stage || 'loading...'}</Text>
        </View>
      ) : posts.length === 0 ? (
        // Finished, and empty. Said so, rather than left looking like a
        // load that never ends.
        <View style={styles.centre}>
          <Text style={styles.empty}>{emptyMessage}</Text>
        </View>
      ) : (
        <FlatList
          ref={list}
          data={posts}
          keyExtractor={(p: TimelinePost) => p.key}
          extraData={{ sessionVersion, statuses }}
          ListHeaderComponent={
            pendingCount > 0 ? (
              <NewPostsRow count={pendingCount} onPress={showNew} />
            ) : null
          }
          renderItem={({ item }: { item: TimelinePost }) => (
            <PostRow
              post={item}
              status={statuses.get(item.pubkey) ?? null}
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
          // About a screen before the end, not at it, so the next page is
          // usually there before the last post is.
          {...olderPostsListProps(older)}
          ListFooterComponent={
            older ? (
              <TimelineFooter state={older} hasPosts={posts.length > 0} />
            ) : null
          }
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
  status: {
    color: '#8fa3c7',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 2,
  },
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
  newRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(137,168,255,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148,163,184,0.14)',
  },
  newRowPressed: { backgroundColor: 'rgba(137,168,255,0.14)' },
  newRule: { flex: 1, height: 1, backgroundColor: 'rgba(137,168,255,0.35)' },
  newText: { color: '#89a8ff', fontSize: 13, fontWeight: '600' },
  footer: {
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  footerText: { color: '#8ea0c0', fontSize: 13 },
  footerButton: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  footerButtonText: { color: '#89a8ff', fontSize: 13, fontWeight: '600' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stage: { color: '#8ea0c0', fontSize: 13 },
  empty: {
    color: '#8ea0c0',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  error: { color: '#ff9a9a', fontSize: 13, paddingHorizontal: 24 },
});

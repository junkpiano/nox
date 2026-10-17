/**
 * Posts carrying one hashtag.
 *
 * This screen is why a tag is worth linking at all. NIP-12 indexes tags as `t`
 * on the event, so a relay can answer the question exactly - a tag is not a
 * text search that happens to find the word in the middle of a sentence.
 */

import { type RouteProp, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { TimelineKey } from '../../src/common/db/types';
import {
  getFollowedHashtags,
  normalizeHashtag,
  refreshFollowedHashtags,
  setHashtagFollowed,
} from '../../src/common/interests';
import { getSession } from '../../src/common/session';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import PostList from '../components/PostList';
import {
  loadHashtagTimeline,
  loadNewerPosts,
  type TimelineFilter,
  type TimelinePost,
} from '../lib/home-timeline';
import { guardWrite, hasViewer } from '../lib/read-only';
import { useNewPosts } from '../lib/use-new-posts';
import { mergeTimelinePosts, useOlderPosts } from '../lib/use-older-posts';

type HashtagRoute = RouteProp<RootStackParamList, 'Hashtag'>;

/** Follow / Following in the header: the tag's posts join Home, or leave it. */
function FollowHashtag({ tag }: { tag: string }) {
  const viewer: PubkeyHex | null = getSession().pubkey;
  const name: string = normalizeHashtag(tag);
  const [following, setFollowing] = useState<boolean>((): boolean =>
    getFollowedHashtags(viewer).includes(name),
  );
  const [busy, setBusy] = useState(false);

  useEffect((): (() => void) | undefined => {
    if (!viewer) return undefined;
    let live: boolean = true;
    void refreshFollowedHashtags(viewer, getRelays())
      .then((tags: string[]): void => {
        if (live) setFollowing(tags.includes(name));
      })
      .catch((): void => {});
    return (): void => {
      live = false;
    };
  }, [viewer, name]);

  if (!viewer || !hasViewer()) return null;
  return (
    <Pressable
      disabled={busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ selected: following, busy }}
      onPress={(): void => {
        if (!guardWrite()) return;
        const next: boolean = !following;
        setBusy(true);
        void setHashtagFollowed(viewer, getRelays(), name, next)
          .then((): void => setFollowing(next))
          .catch((): void =>
            Alert.alert('Could not save', 'Check your relays and try again.'),
          )
          .finally((): void => setBusy(false));
      }}
      style={
        GLASS_HEADER ? null : [styles.follow, following && styles.following]
      }
    >
      <Text
        style={
          GLASS_HEADER
            ? following
              ? styles.glassFollowingText
              : styles.glassFollowText
            : following
              ? styles.followingText
              : styles.followText
        }
      >
        {busy ? '···' : following ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  );
}

export default function Hashtag({
  route,
  navigation,
}: {
  route: HashtagRoute;
  navigation: NativeStackNavigationProp<RootStackParamList, 'Hashtag'>;
}) {
  const { tag } = route.params;

  useLayoutEffect((): void => {
    navigation.setOptions({ headerRight: () => <FollowHashtag tag={tag} /> });
  }, [navigation, tag]);
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TimelineFilter | null>(null);
  const { pendingCount, showNew, forget } = useNewPosts(
    filter,
    posts,
    setPosts,
  );
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | null>(null);
  const [cacheKey, setCacheKey] = useState<TimelineKey | null>(null);
  const active: boolean = useIsFocused();
  const older = useOlderPosts({
    filter,
    oldestCreatedAt,
    cacheKey,
    posts,
    setPosts,
    busy: loading || refreshing,
    active,
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    forget();
    try {
      const result = await loadHashtagTimeline(tag, setStage, {
        // What the cache held goes up at once; the relays follow, and the
        // refresh spinner says so until they have.
        onCached: (cached: TimelinePost[]): void => {
          setPosts(cached);
          setLoading(false);
          setRefreshing(true);
        },
      });
      setPosts(result.posts);
      setFilter(result.filter);
      setOldestCreatedAt(result.oldestCreatedAt);
      setCacheKey(result.cacheKey);
      setStats(
        `${result.stats.events} events / ${result.stats.profiles} profiles / ` +
          `${result.stats.relays} relays / ` +
          `${(result.stats.ms / 1000).toFixed(1)}s`,
      );
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setStage('');
    }
  }, [tag, forget]);

  useEffect((): void => {
    void load();
  }, [load]);

  /**
   * Pull-to-refresh asks for the newer side only. The pages already read
   * further back stay, and so does the cursor: a refresh is not a reload.
   * With nothing on screen yet there is nothing to be newer than, and the
   * first load runs instead.
   */
  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      if (!filter || posts.length === 0) {
        await load();
        return;
      }
      const newest: number = Math.max(
        ...posts.map((post: TimelinePost): number => post.createdAt),
      );
      const fresh: TimelinePost[] = await loadNewerPosts(filter, newest + 1);
      setPosts((previous: TimelinePost[]): TimelinePost[] =>
        mergeTimelinePosts(previous, fresh),
      );
      forget();
    } catch {
      // The posts on screen are still the posts on screen.
    } finally {
      setRefreshing(false);
    }
  }, [filter, posts, load, forget]);

  return (
    <PostList
      posts={posts}
      stats={stats}
      stage={stage}
      error={error}
      refreshing={refreshing}
      onRefresh={onRefresh}
      loading={loading}
      emptyMessage={`No posts tagged #${tag} on these relays.`}
      pendingCount={pendingCount}
      onShowNew={showNew}
      older={older}
    />
  );
}

/**
 * iOS draws a glass capsule around every header button, so the button there
 * is the label alone: a pill of our own inside it read as a button in a
 * button. Android has no capsule, and keeps the pill.
 */
const GLASS_HEADER: boolean = Platform.OS === 'ios';

const styles = StyleSheet.create({
  follow: {
    marginRight: 12,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#89a8ff',
  },
  following: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#25406e',
  },
  followText: { color: '#0b1220', fontSize: 13, fontWeight: '700' },
  followingText: { color: '#bad0ff', fontSize: 13, fontWeight: '600' },
  glassFollowText: { color: '#89a8ff', fontSize: 16, fontWeight: '700' },
  glassFollowingText: { color: '#bad0ff', fontSize: 16, fontWeight: '500' },
});

/**
 * Posts carrying one hashtag.
 *
 * This screen is why a tag is worth linking at all. NIP-12 indexes tags as `t`
 * on the event, so a relay can answer the question exactly - a tag is not a
 * text search that happens to find the word in the middle of a sentence.
 */

import { type RouteProp, useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import type { TimelineKey } from '../../src/common/db/types';
import type { RootStackParamList } from '../App';
import PostList from '../components/PostList';
import {
  loadHashtagTimeline,
  loadNewerPosts,
  type TimelinePost,
} from '../lib/home-timeline';
import { useNewPosts } from '../lib/use-new-posts';
import { mergeTimelinePosts, useOlderPosts } from '../lib/use-older-posts';

type HashtagRoute = RouteProp<RootStackParamList, 'Hashtag'>;

export default function Hashtag({ route }: { route: HashtagRoute }) {
  const { tag } = route.params;
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
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

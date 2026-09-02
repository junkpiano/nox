/**
 * Whatever the configured relays are carrying right now.
 *
 * No follow list, no identity: this screen works before anyone has told the
 * app who they are, which makes it the one thing a new install can show.
 */

import { useCallback, useEffect, useState } from 'react';

import type { TimelineKey } from '../../src/common/db/types';
import PostList from '../components/PostList';
import {
  loadGlobalTimeline,
  loadNewerPosts,
  type TimelinePost,
} from '../lib/home-timeline';
import { useNewPosts } from '../lib/use-new-posts';
import { mergeTimelinePosts, useOlderPosts } from '../lib/use-older-posts';

export default function Global({ active = true }: { active?: boolean }) {
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  // Its own poll and its own waiting posts: Home's do not leak in here.
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  const { pendingCount, showNew, forget } = useNewPosts(
    filter,
    posts,
    setPosts,
  );
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | null>(null);
  const [cacheKey, setCacheKey] = useState<TimelineKey | null>(null);
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
      const result = await loadGlobalTimeline(setStage, {
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
          `${result.stats.relays} relays / ${(result.stats.ms / 1000).toFixed(1)}s`,
      );
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setStage('');
    }
  }, [forget]);

  useEffect(() => {
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
      emptyMessage={'Nothing on these relays in the last six hours.'}
      pendingCount={pendingCount}
      onShowNew={showNew}
      older={older}
    />
  );
}

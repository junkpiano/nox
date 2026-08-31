/**
 * Whatever the configured relays are carrying right now.
 *
 * No follow list, no identity: this screen works before anyone has told the
 * app who they are, which makes it the one thing a new install can show.
 */

import { useCallback, useEffect, useState } from 'react';

import PostList from '../components/PostList';
import { loadGlobalTimeline, type TimelinePost } from '../lib/home-timeline';

export default function Global() {
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await loadGlobalTimeline(setStage);
      setPosts(result.posts);
      setStats(
        `${result.stats.events} events / ${result.stats.profiles} profiles / ` +
          `${result.stats.relays} relays / ${(result.stats.ms / 1000).toFixed(1)}s`,
      );
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <PostList
      posts={posts}
      stats={stats}
      stage={stage}
      error={error}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

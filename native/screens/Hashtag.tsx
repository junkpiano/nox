/**
 * Posts carrying one hashtag.
 *
 * This screen is why a tag is worth linking at all. NIP-12 indexes tags as `t`
 * on the event, so a relay can answer the question exactly - a tag is not a
 * text search that happens to find the word in the middle of a sentence.
 */

import type { RouteProp } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import type { RootStackParamList } from '../App';
import PostList from '../components/PostList';
import { loadHashtagTimeline, type TimelinePost } from '../lib/home-timeline';

type HashtagRoute = RouteProp<RootStackParamList, 'Hashtag'>;

export default function Hashtag({ route }: { route: HashtagRoute }) {
  const { tag } = route.params;
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await loadHashtagTimeline(tag, setStage);
      setPosts(result.posts);
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
      setStage('');
    }
  }, [tag]);

  useEffect((): void => {
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
      loading={loading}
      emptyMessage={`No posts tagged #${tag} on these relays.`}
    />
  );
}

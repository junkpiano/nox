/**
 * The posts you liked.
 *
 * The other direction from Alerts: not what people did to your posts, but
 * the posts you reacted to, newest reaction first. The list is the shared
 * one - the same rows, the same decoration, the same mute and deletion
 * judgement - fed by the shared reader of your kind 7s.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { onAppEvent } from '../../src/common/app-events';
import { kvGet } from '../../src/common/kv';
import {
  fetchLikedEvents,
  fetchLikes,
  type Like,
} from '../../src/common/liked-posts';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import PostList from '../components/PostList';
import { decorateEvents, type TimelinePost } from '../lib/home-timeline';

function readStoredPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

export default function Likes() {
  const [viewer, setViewer] = useState<PubkeyHex | null>(readStoredPubkey);
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (who: PubkeyHex): Promise<void> => {
    setLoading(true);
    try {
      const relays: string[] = getRelays();
      const likes: Like[] = await fetchLikes(who, relays);
      const events: NostrEvent[] = await fetchLikedEvents(likes, relays);
      const decorated = await decorateEvents(relays, events);
      // decorateEvents sorts by the post's own time; this list is ordered by
      // when you liked, which is what "newest first" means here. A like
      // names the event as it arrived - for a repost, the wrapper - which is
      // the row's key, not its id (the note inside).
      const order: Map<string, number> = new Map(
        likes.map((like: Like, index: number): [string, number] => [
          like.targetId,
          index,
        ]),
      );
      const last: number = likes.length;
      setPosts(
        [...decorated.posts].sort(
          (a: TimelinePost, b: TimelinePost): number =>
            (order.get(a.key) ?? last) - (order.get(b.key) ?? last),
        ),
      );
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect((): void => {
    if (viewer) void load(viewer);
  }, [viewer, load]);

  useEffect(
    (): (() => void) =>
      onAppEvent('session-changed', (): void => {
        setPosts([]);
        setViewer(readStoredPubkey());
      }),
    [],
  );

  const onRefresh = useCallback(async (): Promise<void> => {
    if (!viewer) return;
    setRefreshing(true);
    await load(viewer);
    setRefreshing(false);
  }, [viewer, load]);

  if (!viewer) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>Sign in to see the posts you liked.</Text>
      </View>
    );
  }

  return (
    <PostList
      posts={posts}
      stats=""
      stage="your likes..."
      error={error}
      refreshing={refreshing}
      onRefresh={onRefresh}
      loading={loading}
      emptyMessage="No likes yet. The heart on a post puts it here."
    />
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
    padding: 32,
  },
  empty: { color: '#8ea0c0', fontSize: 13, textAlign: 'center' },
});

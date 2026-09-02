/**
 * The home timeline: the people you follow.
 *
 * Everything below the presentation is shared with the web app - the follow
 * list, the relay sockets, the relay list itself. The list itself is
 * `components/PostList`, shared in turn with the global timeline, because the
 * two differ only in which events they ask for.
 */

import { nip19 } from 'nostr-tools';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { onAppEvent } from '../../src/common/app-events';
import { kvGet, kvSet } from '../../src/common/kv';
import type { PubkeyHex } from '../../types/nostr';
import PostList from '../components/PostList';
import {
  loadHomeTimeline,
  loadNewerPosts,
  type TimelinePost,
} from '../lib/home-timeline';
import { useNewPosts } from '../lib/use-new-posts';
import { mergeTimelinePosts, useOlderPosts } from '../lib/use-older-posts';

/** The same key the web app stores the viewer's pubkey under. */
const PUBKEY_KEY = 'nostr_pubkey';

function readStoredPubkey(): PubkeyHex | null {
  const stored = kvGet(PUBKEY_KEY);
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

/** Accepts an npub, an nprofile or a bare hex key, as the web search does. */
function decodeIdentity(input: string): PubkeyHex | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed))
    return trimmed.toLowerCase() as PubkeyHex;
  try {
    const decoded = nip19.decode(trimmed.toLowerCase());
    if (decoded.type === 'npub') return decoded.data as PubkeyHex;
    if (decoded.type === 'nprofile') {
      return (decoded.data as { pubkey: string }).pubkey as PubkeyHex;
    }
  } catch {
    // Not a key.
  }
  return null;
}

function IdentityPrompt({ onChosen }: { onChosen: (key: PubkeyHex) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const key = decodeIdentity(text);
    if (!key) {
      setError('That is not an npub, an nprofile or a 64-character key.');
      return;
    }
    kvSet(PUBKEY_KEY, key);
    setError(null);
    onChosen(key);
  };

  return (
    <View style={styles.prompt}>
      <Text style={styles.promptTitle}>Whose timeline?</Text>
      <Text style={styles.promptSub}>
        Read-only for now: paste an npub and the follow list is fetched from
        your relays. Signing comes with the key store. Until then the global tab
        works without this.
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="npub1..."
        placeholderTextColor="#5b6b88"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable onPress={submit} style={styles.button}>
        <Text style={styles.buttonText}>Load timeline</Text>
      </Pressable>
    </View>
  );
}

export default function Home({ active = true }: { active?: boolean }) {
  const [pubkey, setPubkey] = useState<PubkeyHex | null>(readStoredPubkey);
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  // The question the load asked, so the poll for newer posts asks the same.
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  const { pendingCount, showNew, forget } = useNewPosts(
    filter,
    posts,
    setPosts,
  );
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | null>(null);
  const older = useOlderPosts({
    filter,
    oldestCreatedAt,
    posts,
    setPosts,
    busy: loading || refreshing,
    active,
  });

  const load = useCallback(
    async (viewer: PubkeyHex): Promise<void> => {
      setLoading(true);
      // A full load shows everything, so nothing is waiting any more.
      forget();
      try {
        const result = await loadHomeTimeline(viewer, setStage);
        setPosts(result.posts);
        setFilter(result.filter);
        setOldestCreatedAt(result.oldestCreatedAt);
        setStats(
          `${result.stats.follows} follows / ${result.stats.events} events / ` +
            `${result.stats.profiles} profiles / ${result.stats.relays} relays / ` +
            `${(result.stats.ms / 1000).toFixed(1)}s` +
            (result.stats.muted > 0
              ? ` / ${result.stats.muted} muted hidden`
              : ''),
        );
        setError(null);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setLoading(false);
        setStage('');
      }
    },
    [forget],
  );

  useEffect(() => {
    if (pubkey) void load(pubkey);
  }, [pubkey, load]);

  /**
   * Follow the account, not the first value that was in storage.
   *
   * Signing in as somebody else used to leave the previous account's timeline
   * on screen: this screen read the pubkey once at mount and nothing ever told
   * it otherwise. The posts are cleared as well as reloaded, so the gap shows
   * a spinner rather than the last person's following list.
   */
  useEffect(
    (): (() => void) =>
      onAppEvent('session-changed', (): void => {
        const next: PubkeyHex | null = readStoredPubkey();
        setPosts([]);
        setFilter(null);
        forget();
        setStats('');
        setError(null);
        setPubkey(next);
      }),
    [forget],
  );

  /**
   * Pull-to-refresh asks for the newer side only. The pages already read
   * further back stay, and so does the cursor: a refresh is not a reload.
   * With nothing on screen yet there is nothing to be newer than, and the
   * first load runs instead.
   */
  const onRefresh = useCallback(async (): Promise<void> => {
    if (!pubkey) return;
    setRefreshing(true);
    try {
      if (!filter || posts.length === 0) {
        await load(pubkey);
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
  }, [pubkey, filter, posts, load, forget]);

  if (!pubkey) {
    return <IdentityPrompt onChosen={setPubkey} />;
  }

  return (
    <PostList
      posts={posts}
      stats={stats}
      stage={stage}
      error={error}
      refreshing={refreshing}
      onRefresh={onRefresh}
      loading={loading}
      emptyMessage={
        'You are not following anyone yet. Posts from people you follow will appear here.'
      }
      pendingCount={pendingCount}
      onShowNew={showNew}
      older={older}
    />
  );
}

const styles = StyleSheet.create({
  prompt: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#0b1220',
  },
  promptTitle: { color: '#f5f8ff', fontSize: 22, fontWeight: '700' },
  promptSub: {
    color: '#8ea0c0',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
  },
  error: { color: '#ff9a9a', fontSize: 13 },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
});

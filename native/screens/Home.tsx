/**
 * The home timeline.
 *
 * Everything below the presentation is shared with the web app: the follow
 * list, the relay sockets, the relay list itself. What is written here is the
 * list, the gesture and the identity prompt - the parts that genuinely differ
 * between a browser tab and a phone.
 *
 * The HUD across the top is kept from the prototype deliberately. It reports
 * how many rows are actually mounted against the total, which is the one claim
 * about React Native that a screenshot can settle: the web build holds every
 * card in the DOM, and this does not.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { nip19 } from 'nostr-tools';

import type { PubkeyHex } from '../../types/nostr';
import { kvGet, kvSet } from '../../src/common/kv';
import { loadHomeTimeline, type TimelinePost } from '../lib/home-timeline';

/** The same key the web app stores the viewer's pubkey under. */
const PUBKEY_KEY = 'nostr_pubkey';

/** Live count of mounted rows, so virtualisation is visible rather than claimed. */
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

function readStoredPubkey(): PubkeyHex | null {
  const stored = kvGet(PUBKEY_KEY);
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

/** Accepts an npub, an nprofile or a bare hex key, as the web search does. */
function decodeIdentity(input: string): PubkeyHex | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase() as PubkeyHex;
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

function Row({ post }: { post: TimelinePost }) {
  useEffect(() => {
    bumpMounted(1);
    return () => bumpMounted(-1);
  }, []);

  return (
    <View style={styles.row}>
      {post.picture ? (
        <Image source={{ uri: post.picture }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarBlank]} />
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.name} numberOfLines={1}>
            {post.name}
          </Text>
          {post.kind === 6 ? <Text style={styles.badge}>repost</Text> : null}
        </View>
        {post.nip05 ? (
          <Text style={styles.nip05} numberOfLines={1}>
            {post.nip05}
          </Text>
        ) : null}
        <Text style={styles.content} numberOfLines={12}>
          {post.content}
        </Text>
      </View>
    </View>
  );
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
        your relays. Signing comes with the key store.
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

export default function Home() {
  const [pubkey, setPubkey] = useState<PubkeyHex | null>(readStoredPubkey);
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [stage, setStage] = useState('');
  const [stats, setStats] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offset, setOffset] = useState(0);

  const live = useMountedRows();

  const load = useCallback(
    async (viewer: PubkeyHex): Promise<void> => {
      try {
        const result = await loadHomeTimeline(viewer, setStage);
        setPosts(result.posts);
        setStats(
          `${result.stats.follows} follows / ${result.stats.events} events / ` +
            `${result.stats.profiles} profiles / ${result.stats.relays} relays / ` +
            `${(result.stats.ms / 1000).toFixed(1)}s`,
        );
        setError(null);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    },
    [],
  );

  useEffect(() => {
    if (pubkey) void load(pubkey);
  }, [pubkey, load]);

  const onRefresh = useCallback(async (): Promise<void> => {
    if (!pubkey) return;
    setRefreshing(true);
    await load(pubkey);
    setRefreshing(false);
  }, [pubkey, load]);

  if (!pubkey) {
    return <IdentityPrompt onChosen={setPubkey} />;
  }

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
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <Row post={item} />}
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
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#25406e' },
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
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stage: { color: '#8ea0c0', fontSize: 13 },
  error: { color: '#ff9a9a', fontSize: 13, paddingHorizontal: 24 },
  prompt: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  promptTitle: { color: '#f5f8ff', fontSize: 22, fontWeight: '700' },
  promptSub: { color: '#8ea0c0', fontSize: 13, lineHeight: 19, marginBottom: 8 },
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
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
});

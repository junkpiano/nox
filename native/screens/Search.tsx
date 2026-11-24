/**
 * Finding a person, a post, or a hashtag.
 *
 * With nothing typed, the hashtags you follow are listed: following one only
 * adds its posts to Home, and this is where they can be found again. `#word`
 * opens that hashtag. Words find people or posts, whichever tab is chosen;
 * posts come from the same NIP-50 search relays the web app asks.
 *
 * The ranking is the web app's, unchanged - the same four tiers, with a
 * claimed NIP-05 breaking ties inside each. A pasted key skips the search
 * relays entirely: it names one person, and there is nothing for a text search
 * to match. That is the whole reason the ranking was split out of
 * `user-search.ts`, and this screen is the proof it paid off.
 */

import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { nip19 } from 'nostr-tools';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { onAppEvent } from '../../src/common/app-events';
import {
  getFollowedHashtags,
  hashtagQuery,
  refreshFollowedHashtags,
} from '../../src/common/interests';
import { kvGet } from '../../src/common/kv';
import { getRelays } from '../../src/features/relays/relays';
import {
  decodePubkeyQuery,
  MAX_ABOUT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NIP05_LENGTH,
  oneLine,
  type UserSearchResult,
} from '../../src/features/search/user-ranking';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import PostList from '../components/PostList';
import { pictureUrl } from '../lib/avatar';
import { searchPosts, type TimelinePost } from '../lib/home-timeline';
import { searchUsers } from '../lib/user-search';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** How many survive the ranking and reach the screen. */
const SHOWN: number = 12;

type Mode = 'people' | 'posts';
const MODES: readonly Mode[] = ['people', 'posts'];
const MODE_LABEL: Record<Mode, string> = { people: 'People', posts: 'Posts' };

function readViewer(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [posts, setPosts] = useState<TimelinePost[]>([]);
  const [mode, setMode] = useState<Mode>('people');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  /** Only the latest search may write its answer; an earlier, slower one is dropped. */
  const latest = useRef(0);
  const navigation = useNavigation<Nav>();
  const focused: boolean = useIsFocused();
  const [hashtags, setHashtags] = useState<string[]>((): string[] =>
    getFollowedHashtags(readViewer()),
  );

  // Read again whenever the tab is shown or the list changes - on this
  // device, from a hashtag's screen, or found changed on another.
  useEffect((): (() => void) | undefined => {
    if (!focused) return undefined;
    const viewer: PubkeyHex | null = readViewer();
    let live: boolean = true;
    const read = (): void => {
      if (live) setHashtags(getFollowedHashtags(viewer));
    };
    read();
    if (viewer) {
      void refreshFollowedHashtags(viewer, getRelays())
        .then(read)
        .catch((): void => {});
    }
    const stop = onAppEvent('interests-updated', read);
    return (): void => {
      live = false;
      stop();
    };
  }, [focused]);

  const run = useCallback(
    async (searchMode: Mode): Promise<void> => {
      const trimmed = query.trim();
      if (!trimmed) return;

      const tag: string | null = hashtagQuery(trimmed);
      if (tag) {
        navigation.navigate('Hashtag', { tag });
        return;
      }

      // A pasted key names one person exactly. Handing it to a search relay as
      // text gets it ignored as an unmatched term, and the relay answers with
      // whatever is recent - a hundred strangers under a header naming the key.
      const pasted = decodePubkeyQuery(trimmed);
      if (pasted) {
        navigation.navigate('Profile', { pubkey: pasted });
        return;
      }

      const ticket: number = ++latest.current;
      const current = (): boolean => ticket === latest.current;
      setBusy(true);
      setNote('');
      // The last query's rows must not stand under the new one, nor under its error.
      setPosts([]);
      setResults([]);
      try {
        if (searchMode === 'posts') {
          const found: TimelinePost[] = await searchPosts(trimmed);
          if (!current()) return;
          setPosts(found);
          setNote(found.length === 0 ? 'No posts found.' : '');
          return;
        }
        const outcome = await searchUsers(trimmed, readViewer());
        if (!current()) return;
        setResults(outcome.results.slice(0, SHOWN));
        setNote(
          outcome.results.length === 0
            ? 'Nobody found on the search relays.'
            : // Timings are for development builds; the list speaks for itself.
              __DEV__
              ? `${outcome.results.length} found in ${(outcome.ms / 1000).toFixed(1)}s, best ${Math.min(SHOWN, outcome.results.length)} shown`
              : '',
        );
      } catch (e: any) {
        if (current()) setNote(String(e?.message ?? e));
      } finally {
        if (current()) setBusy(false);
      }
    },
    [query, navigation],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="name, words, npub or #hashtag"
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={(): void => void run(mode)}
          style={styles.input}
        />
        <Pressable onPress={(): void => void run(mode)} style={styles.button}>
          <Text style={styles.buttonText}>Find</Text>
        </Pressable>
      </View>
      {/* A #tag or a key goes straight to its screen; People or Posts would mean nothing. */}
      {query.trim() &&
      !hashtagQuery(query.trim()) &&
      !decodePubkeyQuery(query.trim()) ? (
        <View style={styles.modes} accessibilityRole="tablist">
          {MODES.map((m: Mode) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: m === mode }}
              onPress={(): void => {
                if (m === mode) return;
                setMode(m);
                void run(m);
              }}
              hitSlop={8}
            >
              <Text style={m === mode ? styles.modeOn : styles.modeOff}>
                {MODE_LABEL[m]}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {note && query.trim() ? <Text style={styles.note}>{note}</Text> : null}

      {busy ? (
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
        </View>
      ) : !query.trim() ? (
        <FlatList
          data={hashtags}
          keyExtractor={(tag: string): string => tag}
          ListHeaderComponent={
            readViewer() ? (
              <Text style={styles.section}>Hashtags you follow</Text>
            ) : null
          }
          ListEmptyComponent={
            readViewer() ? (
              <Text style={styles.empty}>
                Hashtags you follow appear here. Tap one in any post to follow
                it.
              </Text>
            ) : null
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }: { item: string }) => (
            <Pressable
              onPress={(): void =>
                navigation.navigate('Hashtag', { tag: item })
              }
              style={({ pressed }) => [
                styles.tagRow,
                pressed && styles.rowPressed,
              ]}
              accessibilityRole="button"
            >
              <Text style={styles.tag} numberOfLines={1}>
                #{item}
              </Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      ) : mode === 'posts' ? (
        <PostList
          posts={posts}
          loading={busy}
          emptyMessage=""
          stats=""
          stage=""
          error={null}
          refreshing={false}
          onRefresh={(): void => void run('posts')}
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(r: UserSearchResult) => r.pubkey}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }: { item: UserSearchResult }) => {
            const name =
              oneLine(item.profile.display_name, MAX_NAME_LENGTH) ||
              oneLine(item.profile.name, MAX_NAME_LENGTH) ||
              `${nip19.npubEncode(item.pubkey).slice(0, 12)}...`;
            const nip05 = oneLine(item.profile.nip05, MAX_NIP05_LENGTH);
            const about = oneLine(item.profile.about, MAX_ABOUT_LENGTH);
            const picture = pictureUrl(item.profile.picture);

            return (
              <Pressable
                onPress={() =>
                  navigation.navigate('Profile', { pubkey: item.pubkey })
                }
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.rowPressed,
                ]}
              >
                {picture ? (
                  <Image source={{ uri: picture }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarBlank]} />
                )}
                <View style={styles.rowBody}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.nip05} numberOfLines={1}>
                    {nip05 ||
                      `${nip19.npubEncode(item.pubkey).slice(0, 20)}...`}
                  </Text>
                  {about ? (
                    <Text style={styles.about} numberOfLines={2}>
                      {about}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  bar: { flexDirection: 'row', gap: 8, padding: 16 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
  },
  button: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  buttonText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  note: {
    color: '#5b6b88',
    fontSize: 11,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  modes: {
    flexDirection: 'row',
    gap: 20,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  modeOn: { color: '#89a8ff', fontSize: 14, fontWeight: '700' },
  modeOff: { color: '#5b6b88', fontSize: 14, fontWeight: '600' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
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
  name: { color: '#e8eeff', fontWeight: '700', fontSize: 14 },
  nip05: { color: '#5b6b88', fontSize: 11, marginTop: 1 },
  about: { color: '#b9c6de', fontSize: 12, marginTop: 3 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  section: {
    color: '#8ea0c0',
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  empty: {
    color: '#8ea0c0',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  tag: { flex: 1, color: '#89a8ff', fontSize: 16, fontWeight: '600' },
  chevron: { color: '#5b6b88', fontSize: 22 },
});

/**
 * Finding a person.
 *
 * The ranking is the web app's, unchanged - the same four tiers, with a
 * claimed NIP-05 breaking ties inside each. A pasted key skips the search
 * relays entirely: it names one person, and there is nothing for a text search
 * to match. That is the whole reason the ranking was split out of
 * `user-search.ts`, and this screen is the proof it paid off.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { nip19 } from 'nostr-tools';
import { useCallback, useState } from 'react';
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
import { kvGet } from '../../src/common/kv';
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
import { pictureUrl } from '../lib/avatar';
import { searchUsers } from '../lib/user-search';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** How many survive the ranking and reach the screen. */
const SHOWN: number = 12;

function readViewer(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const navigation = useNavigation<Nav>();

  const run = useCallback(async (): Promise<void> => {
    const trimmed = query.trim();
    if (!trimmed) return;

    // A pasted key names one person exactly. Handing it to a search relay as
    // text gets it ignored as an unmatched term, and the relay answers with
    // whatever is recent - a hundred strangers under a header naming the key.
    const pasted = decodePubkeyQuery(trimmed);
    if (pasted) {
      navigation.navigate('Profile', { pubkey: pasted });
      return;
    }

    setBusy(true);
    setNote('');
    try {
      const outcome = await searchUsers(trimmed, readViewer());
      setResults(outcome.results.slice(0, SHOWN));
      setNote(
        outcome.results.length === 0
          ? 'Nobody found on the search relays.'
          : `${outcome.results.length} found in ${(outcome.ms / 1000).toFixed(1)}s, best ${Math.min(SHOWN, outcome.results.length)} shown`,
      );
    } catch (e: any) {
      setNote(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [query, navigation]);

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="name, npub or nprofile"
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={run}
          style={styles.input}
        />
        <Pressable onPress={run} style={styles.button}>
          <Text style={styles.buttonText}>Find</Text>
        </Pressable>
      </View>
      {note ? <Text style={styles.note}>{note}</Text> : null}

      {busy ? (
        <View style={styles.centre}>
          <ActivityIndicator color="#89a8ff" />
        </View>
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
});

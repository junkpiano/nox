/**
 * Who gave one reaction to a post - or, opened without one, who reposted it.
 *
 * Opened from a reaction badge, as the platform's own sheet (a native form
 * sheet with a grabber, half height, draggable to full): the badge says how
 * many, this says who. One
 * row per person, most recent first, with a count when they gave it more
 * than once. A custom emoji can be added to your own from here, which is the
 * other thing a badge used to offer.
 *
 * The asking and grouping are shared with the web (`fetchReactors`); the
 * names come from the shared profile lookup.
 */

import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { loadableImageUrl } from '../../src/common/avatar';
import type { EmojiMap } from '../../src/common/content-segments';
import { addToEmojiList } from '../../src/common/emoji-list';
import { fetchProfiles } from '../../src/common/profile-fetch';
import {
  fetchReactors,
  fetchReposters,
  type Reactor,
} from '../../src/common/reaction-summary';
import { getSession } from '../../src/common/session';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrProfile, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { customEmojiOf, pictureUrl } from '../lib/avatar';
import { guardWrite } from '../lib/read-only';
import { TYPE } from '../lib/type';
import { forgetEmojiList } from './EmojiPickerSheet';
import EmojiText from './EmojiText';
import Icon from './Icon';

const PHONE_IMAGES = { secureOnly: true } as const;
const EMPTY_EMOJI: EmojiMap = new Map();

interface Row extends Reactor {
  name: string;
  emoji: EmojiMap;
  picture: string | null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowFor(reactor: Reactor, profile: NostrProfile | undefined): Row {
  return {
    ...reactor,
    name:
      str(profile?.display_name) ||
      str(profile?.name) ||
      `${reactor.pubkey.slice(0, 8)}…`,
    emoji: profile
      ? customEmojiOf(
          Array.isArray(profile.emojiTags)
            ? (profile.emojiTags as string[][])
            : [],
        )
      : EMPTY_EMOJI,
    picture: pictureUrl(profile?.picture),
  };
}

export default function ReactorsSheet({
  route,
  navigation,
}: {
  route: RouteProp<RootStackParamList, 'Reactors'>;
  navigation: NativeStackNavigationProp<RootStackParamList, 'Reactors'>;
}) {
  const { eventId, entry, symbol } = route.params;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect((): (() => void) => {
    let live: boolean = true;
    setRows(null);
    setFailed(false);
    const relays: string[] = getRelays();
    void (
      entry
        ? fetchReactors(eventId, entry.key, relays)
        : fetchReposters(eventId, relays)
    )
      .then(async (reactors: Reactor[]): Promise<void> => {
        if (!live) return;
        // The list first, with whatever names are already known; the rest
        // fill in when the relays answer.
        const cached: Map<PubkeyHex, NostrProfile> = await fetchProfiles(
          reactors.map((reactor: Reactor): PubkeyHex => reactor.pubkey),
          relays,
          { cachedOnly: true },
        );
        if (!live) return;
        setRows(reactors.map((r) => rowFor(r, cached.get(r.pubkey))));
        const named: Map<PubkeyHex, NostrProfile> = await fetchProfiles(
          reactors.map((reactor: Reactor): PubkeyHex => reactor.pubkey),
          relays,
        );
        if (!live) return;
        setRows(reactors.map((r) => rowFor(r, named.get(r.pubkey))));
      })
      .catch((): void => {
        if (live) setFailed(true);
      });
    return (): void => {
      live = false;
    };
  }, [eventId, entry]);

  const viewer: PubkeyHex | null = getSession().pubkey;
  const emojiPicture: string | null = entry?.imageUrl
    ? loadableImageUrl(entry.imageUrl, PHONE_IMAGES)
    : null;
  const canAddEmoji: boolean = Boolean(
    entry?.shortcode && entry.imageUrl && emojiPicture && viewer,
  );

  const addEmoji = (): void => {
    if (!entry?.shortcode || !entry.imageUrl || !viewer) return;
    if (!guardWrite()) return;
    void addToEmojiList(viewer, getRelays(), {
      shortcode: entry.shortcode,
      url: entry.imageUrl,
    })
      .then((outcome): void => {
        forgetEmojiList(viewer);
        Alert.alert(
          outcome === 'added' ? 'Added to your emoji' : 'Already in your emoji',
        );
      })
      .catch((): void => Alert.alert('Could not add. Try again.'));
  };

  // The sheet gives way to the profile rather than staying under it.
  const openProfile = (pubkey: PubkeyHex): void => {
    navigation.replace('Profile', { pubkey });
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        {!entry ? (
          <Icon name="repost" size={24} color="#e8eeff" />
        ) : emojiPicture ? (
          <Image source={{ uri: emojiPicture }} style={styles.titleImage} />
        ) : (
          <Text style={styles.titleSymbol}>{symbol}</Text>
        )}
        <Text style={styles.title}>
          {entry
            ? entry.count === 1
              ? '1 reaction'
              : `${entry.count} reactions`
            : rows === null
              ? 'Reposts'
              : rows.length === 1
                ? '1 repost'
                : `${rows.length} reposts`}
        </Text>
      </View>

      {canAddEmoji ? (
        <Pressable
          onPress={addEmoji}
          style={({ pressed }) => [styles.add, pressed && styles.pressed]}
        >
          <Text style={styles.addText}>
            Add :{entry?.shortcode}: to my emoji
          </Text>
        </Pressable>
      ) : null}

      {failed ? (
        <Text style={styles.note}>Could not reach your relays. Try again.</Text>
      ) : rows === null ? (
        <ActivityIndicator color="#89a8ff" style={styles.loading} />
      ) : rows.length === 0 ? (
        <Text style={styles.note}>
          Nobody found on your relays: these may have been withdrawn.
        </Text>
      ) : (
        <FlatList
          style={styles.list}
          data={rows}
          keyExtractor={(row: Row): string => row.pubkey}
          renderItem={({ item }: { item: Row }) => (
            <Pressable
              onPress={(): void => openProfile(item.pubkey)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              {item.picture ? (
                <Image source={{ uri: item.picture }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarBlank]} />
              )}
              <EmojiText
                text={item.name}
                emoji={item.emoji}
                style={styles.name}
                numberOfLines={1}
              />
              {item.count > 1 ? (
                <Text style={styles.times}>×{item.count}</Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: '#101a2e',
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  titleSymbol: { fontSize: 24, color: '#e8eeff' },
  titleImage: { width: 26, height: 26 },
  title: { color: '#f5f8ff', fontSize: TYPE.lead, fontWeight: '700' },
  add: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  addText: { color: '#89a8ff', fontSize: TYPE.label, fontWeight: '700' },
  note: { color: '#8ea0c0', fontSize: TYPE.meta, lineHeight: 19 },
  loading: { paddingVertical: 24 },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingVertical: 6,
  },
  pressed: { opacity: 0.6 },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarBlank: { backgroundColor: '#25406e' },
  name: { flex: 1, color: '#e8eeff', fontSize: TYPE.name, fontWeight: '600' },
  times: { color: '#8ea0c0', fontSize: TYPE.meta, fontWeight: '700' },
});

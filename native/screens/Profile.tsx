/**
 * One person's profile and recent posts.
 *
 * Reached by tapping a row in the timeline. The header scrolls with the list
 * rather than sitting above it, which is what `ListHeaderComponent` is for -
 * a header outside the list would cost a wrapper that breaks virtualisation,
 * and virtualisation is most of why this app is being written in React Native.
 */

import { useEffect, useState } from 'react';
import type { RouteProp } from '@react-navigation/native';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { nip19 } from 'nostr-tools';

import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { loadProfile, type Profile as ProfileData } from '../lib/profile';

type ProfileRoute = RouteProp<RootStackParamList, 'Profile'>;

function Header({ profile }: { profile: ProfileData }) {
  const npub: string = nip19.npubEncode(profile.pubkey);

  return (
    <View>
      {profile.banner ? (
        <Image source={{ uri: profile.banner }} style={styles.banner} />
      ) : (
        <View style={[styles.banner, styles.bannerBlank]} />
      )}

      <View style={styles.headerBody}>
        {profile.picture ? (
          <Image source={{ uri: profile.picture }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarBlank]} />
        )}

        <Text style={styles.name}>{profile.name}</Text>
        {profile.nip05 ? (
          <Text style={styles.nip05}>{profile.nip05}</Text>
        ) : (
          <Text style={styles.npub}>{`${npub.slice(0, 20)}...`}</Text>
        )}

        {profile.about ? <Text style={styles.about}>{profile.about}</Text> : null}

        {profile.website ? (
          <Pressable
            onPress={() => {
              // Only http(s): a profile field is a string a stranger chose,
              // and Linking will happily open schemes that are not links.
              if (/^https?:\/\//i.test(profile.website ?? '')) {
                void Linking.openURL(profile.website as string);
              }
            }}
          >
            <Text style={styles.website}>{profile.website}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.divider} />
    </View>
  );
}

export default function Profile({ route }: { route: ProfileRoute }) {
  const pubkey: PubkeyHex = route.params.pubkey;
  const [data, setData] = useState<{
    profile: ProfileData;
    posts: NostrEvent[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfile(pubkey)
      .then(setData)
      .catch((e: any) => setError(String(e?.message ?? e)));
  }, [pubkey]);

  if (error) {
    return (
      <View style={styles.centre}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      data={data.posts}
      keyExtractor={(event: NostrEvent) => event.id}
      ListHeaderComponent={<Header profile={data.profile} />}
      ListEmptyComponent={
        <Text style={styles.empty}>No posts found on these relays.</Text>
      }
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      renderItem={({ item }: { item: NostrEvent }) => (
        <View style={styles.post}>
          <Text style={styles.postContent} numberOfLines={12}>
            {item.content}
          </Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  banner: { width: '100%', height: 120, backgroundColor: '#16233f' },
  bannerBlank: { opacity: 0.6 },
  headerBody: { paddingHorizontal: 16, paddingBottom: 16, marginTop: -30 },
  avatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#25406e',
    borderWidth: 3,
    borderColor: '#0b1220',
  },
  avatarBlank: { opacity: 0.6 },
  name: { color: '#f5f8ff', fontSize: 20, fontWeight: '700', marginTop: 8 },
  nip05: { color: '#89a8ff', fontSize: 13, marginTop: 2 },
  npub: { color: '#5b6b88', fontSize: 12, marginTop: 2 },
  about: { color: '#b9c6de', fontSize: 14, lineHeight: 20, marginTop: 10 },
  website: { color: '#89a8ff', fontSize: 13, marginTop: 8 },
  divider: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  post: { paddingHorizontal: 16, paddingVertical: 14 },
  postContent: { color: '#b9c6de', fontSize: 14, lineHeight: 20 },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
  },
  error: { color: '#ff9a9a', fontSize: 13, paddingHorizontal: 24 },
  empty: { color: '#5b6b88', fontSize: 13, padding: 24, textAlign: 'center' },
});

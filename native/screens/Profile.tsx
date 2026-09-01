/**
 * One person's profile and recent posts.
 *
 * Reached by tapping a row in the timeline. The header scrolls with the list
 * rather than sitting above it, which is what `ListHeaderComponent` is for -
 * a header outside the list would cost a wrapper that breaks virtualisation,
 * and virtualisation is most of why this app is being written in React Native.
 */

import type { RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { nip19 } from 'nostr-tools';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { kvGet } from '../../src/common/kv';
import { isMuted } from '../../src/common/mute-state';
import { getSessionPrivateKey } from '../../src/common/session';
import {
  muteUser,
  unmuteUser,
} from '../../src/features/moderation/moderation-actions';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import ReportSheet from '../components/ReportSheet';
import {
  NotSignedInError,
  readFollowing,
  setFollowing,
  UnknownFollowListError,
} from '../lib/interact';
import { loadProfile, type Profile as ProfileData } from '../lib/profile';

type ProfileRoute = RouteProp<RootStackParamList, 'Profile'>;

function viewerPubkey(): PubkeyHex | null {
  const stored = kvGet('nostr_pubkey');
  return stored && /^[0-9a-f]{64}$/i.test(stored)
    ? (stored.toLowerCase() as PubkeyHex)
    : null;
}

/**
 * Follow, when there is a key to sign with.
 *
 * The button starts in an unknown state and says so, because the answer needs
 * a round trip to the relays. Guessing "not following" and correcting later
 * would show the wrong verb for a second and invite a tap that undoes what the
 * person already has.
 */
function FollowButton({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const [following, setFollowingState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!viewer || !getSessionPrivateKey()) return;
    void readFollowing(viewer, target)
      .then(setFollowingState)
      .catch((): void => setFollowingState(null));
  }, [viewer, target]);

  if (!viewer || !getSessionPrivateKey() || viewer === target) {
    return null;
  }

  const toggle = async (): Promise<void> => {
    if (following === null) return;
    setBusy(true);
    try {
      const outcome = await setFollowing(viewer, target, !following);
      if (outcome.result.accepted.length === 0) {
        Alert.alert('Not sent', 'No relay accepted the change.');
        return;
      }
      setFollowingState(outcome.following);
    } catch (e: any) {
      if (e instanceof UnknownFollowListError) {
        // The refusal that keeps a failed fetch from wiping the whole list.
        Alert.alert('Your follow list could not be read', String(e.message));
      } else if (e instanceof NotSignedInError) {
        Alert.alert('Not signed in', 'Add a key on the You tab to follow.');
      } else {
        Alert.alert('Could not change it', String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={toggle}
      disabled={busy || following === null}
      style={[styles.follow, (busy || following === null) && styles.followOff]}
    >
      <Text style={styles.followText}>
        {following === null
          ? 'Checking...'
          : busy
            ? 'Saving...'
            : following
              ? 'Unfollow'
              : 'Follow'}
      </Text>
    </Pressable>
  );
}

/**
 * Mute, and unmute.
 *
 * Muting is kept private: NIP-51 puts the entries in NIP-44 encrypted content
 * rather than public `p` tags, so relays and other people cannot read who has
 * been blocked. That is handled by the shared moderation code; what is decided
 * here is only that muting takes effect locally even when the publish fails,
 * because the person's intent outlives a relay's bad day.
 */
function MuteButton({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const [muted, setMuted] = useState<boolean>(() => isMuted(target));
  const [busy, setBusy] = useState(false);

  if (!viewer || viewer === target) {
    return null;
  }

  const toggle = (): void => {
    const next = !muted;
    const run = async (): Promise<void> => {
      setBusy(true);
      try {
        if (next) {
          await muteUser(target, getRelays());
        } else {
          await unmuteUser(target, getRelays());
        }
        setMuted(next);
      } catch (e: any) {
        // The local list has already changed - the shared action does that
        // first on purpose - so the state is updated and the failure is only
        // about the list not reaching other clients.
        setMuted(isMuted(target));
        Alert.alert(
          'Saved on this phone only',
          `The change did not reach your relays, so your other clients will ` +
            `not know about it yet.\n\n${String(e?.message ?? e)}`,
        );
      } finally {
        setBusy(false);
      }
    };

    if (next) {
      Alert.alert(
        'Mute this person?',
        'Their posts stop appearing in your timelines and notifications. The ' +
          'list is encrypted to you, so nobody else can read who is on it.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Mute',
            style: 'destructive',
            onPress: (): void => void run(),
          },
        ],
      );
      return;
    }
    void run();
  };

  // Deliberately quieter than Follow. Following is the everyday action and
  // muting is a rare defensive one; giving them the same weight makes the
  // page look like it is offering two equal choices, which it is not.
  return (
    <Pressable onPress={toggle} disabled={busy} hitSlop={8}>
      <Text style={[styles.muteLink, busy && styles.followOff]}>
        {busy ? 'Saving...' : muted ? 'Unmute this person' : 'Mute'}
      </Text>
    </Pressable>
  );
}

/**
 * Report, sitting next to Mute.
 *
 * Quieter than both Follow and Mute. Muting is the action that helps the
 * person looking at this screen; reporting asks somebody else to do something,
 * which is worth offering and not worth advertising.
 */
function ReportLink({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const [open, setOpen] = useState(false);

  if (!viewer || viewer === target) {
    return null;
  }

  return (
    <>
      <Pressable onPress={(): void => setOpen(true)} hitSlop={8}>
        <Text style={styles.muteLink}>Report</Text>
      </Pressable>
      <ReportSheet
        visible={open}
        target={target}
        onClose={(): void => setOpen(false)}
      />
    </>
  );
}

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

        {profile.about ? (
          <Text style={styles.about}>{profile.about}</Text>
        ) : null}

        <FollowButton target={profile.pubkey} />
        <View style={styles.quietActions}>
          <MuteButton target={profile.pubkey} />
          <ReportLink target={profile.pubkey} />
        </View>

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
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

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
        // A post opens its thread here as it does in a timeline. A card that
        // is tappable in one list and inert in another reads as a bug even
        // when nobody can say which of the two is wrong.
        <Pressable
          onPress={() => navigation.push('Thread', { eventId: item.id })}
          style={({ pressed }) => [styles.post, pressed && styles.postPressed]}
        >
          <Text style={styles.postContent} numberOfLines={12}>
            {item.content}
          </Text>
        </Pressable>
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
  follow: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  followOff: { opacity: 0.5 },
  followText: { color: '#89a8ff', fontWeight: '700', fontSize: 14 },
  muteLink: { color: '#5b6b88', fontSize: 12 },
  quietActions: { flexDirection: 'row', gap: 18, marginTop: 12 },
  divider: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  post: { paddingHorizontal: 16, paddingVertical: 14 },
  postContent: { color: '#b9c6de', fontSize: 14, lineHeight: 20 },
  postPressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
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

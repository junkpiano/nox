import { canWrite } from '../../src/common/signer';
import { guardWrite, signInPrompt } from '../lib/read-only';
/**
 * One person's profile and recent posts.
 *
 * Reached by tapping a row in the timeline. The header scrolls with the list
 * rather than sitting above it, which is what `ListHeaderComponent` is for -
 * a header outside the list would cost a wrapper that breaks virtualisation,
 * and virtualisation is most of why this app is being written in React Native.
 */

import type { RouteProp } from '@react-navigation/native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
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
import type { TimelineKey } from '../../src/common/db/types';
import { kvGet } from '../../src/common/kv';
import { isMuted } from '../../src/common/mute-state';
import { fetchFollowSet } from '../../src/common/notification-filter';
import {
  muteUser,
  unmuteUser,
} from '../../src/features/moderation/moderation-actions';
import type { UserStatus } from '../../src/features/profile/user-status';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import {
  olderPostsListProps,
  PostRow,
  TimelineFooter,
} from '../components/PostList';
import ReportSheet from '../components/ReportSheet';
import RichText from '../components/RichText';
import ZapSheet from '../components/ZapSheet';
import { decorateEvents, type TimelinePost } from '../lib/home-timeline';
import {
  NotSignedInError,
  readFollowing,
  setFollowing,
  UnknownFollowListError,
} from '../lib/interact';
import { loadProfile, type Profile as ProfileData } from '../lib/profile';
import { useOlderPosts } from '../lib/use-older-posts';
import { useOwnReactions } from '../lib/use-own-reactions';
import { useUserStatus, useUserStatuses } from '../lib/use-user-statuses';

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

  const writable: boolean = canWrite();

  useEffect(() => {
    if (!viewer || !writable) return;
    void readFollowing(viewer, target)
      .then(setFollowingState)
      .catch((): void => setFollowingState(null));
  }, [viewer, target, writable]);

  if (!viewer || viewer === target) {
    return null;
  }
  if (!writable) {
    // Disabled rather than gone: this is where the person learns what
    // signing in would let them do here.
    return (
      <Pressable
        onPress={(): void => {
          guardWrite();
        }}
        style={[styles.follow, styles.followOff]}
      >
        <Text style={styles.followText}>Follow</Text>
      </Pressable>
    );
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
        signInPrompt('Not signed in', 'Sign in to follow.');
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

  if (!viewer || viewer === target || !canWrite()) {
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
/**
 * Zapping the person rather than one of their posts.
 *
 * The same sheet, without an event: NIP-57 sends it to the pubkey instead,
 * and the recipient's Lightning address is on the profile that is already
 * open.
 */
function ZapLink({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const [open, setOpen] = useState(false);

  if (!viewer || viewer === target || !canWrite()) {
    return null;
  }

  return (
    <>
      <Pressable onPress={(): void => setOpen(true)} hitSlop={8}>
        <Text style={styles.zapLink}>⚡ Zap</Text>
      </Pressable>
      <ZapSheet
        visible={open}
        recipientPubkey={target}
        senderPubkey={viewer}
        onClose={(): void => setOpen(false)}
      />
    </>
  );
}

function ReportLink({ target }: { target: PubkeyHex }) {
  const viewer = viewerPubkey();
  const [open, setOpen] = useState(false);

  if (!viewer || viewer === target || !canWrite()) {
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

/** Roughly six lines of bio; past that the rest is behind "Show more". */
const BIO_FOLD_LINES: number = 6;

function bioIsLong(about: string): boolean {
  return about.length > 280 || about.split('\n').length > BIO_FOLD_LINES;
}

function Header({ profile }: { profile: ProfileData }) {
  const npub: string = nip19.npubEncode(profile.pubkey);
  // NIP-38: filled in after the fact, like the web app does it. A status
  // is decoration on a profile, and not finding one is not an error.
  const status: UserStatus | null = useUserStatus(profile.pubkey);
  const [bioOpen, setBioOpen] = useState(false);
  // How many people they follow, from their own kind 3, through the same
  // function the web app and Notifications use. No answer, or no list on
  // these relays, leaves the number out rather than showing a zero.
  const [followingCount, setFollowingCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFollowingCount(null);
    fetchFollowSet(profile.pubkey, getRelays())
      .then((set): void => {
        if (!cancelled && set) setFollowingCount(set.size);
      })
      .catch((): void => {});
    return (): void => {
      cancelled = true;
    };
  }, [profile.pubkey]);
  const longBio: boolean = Boolean(profile.about && bioIsLong(profile.about));

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

        <RichText
          content={profile.name}
          style={styles.name}
          linkStyle={styles.link}
          emoji={profile.emoji}
        />
        {/* Where they can be reached and how many they follow: one line
            under the name, so the facts about the person sit together. */}
        <View style={styles.identity}>
          {profile.nip05 ? (
            <Text style={styles.nip05}>{profile.nip05}</Text>
          ) : (
            <Text style={styles.npub}>{`${npub.slice(0, 20)}...`}</Text>
          )}
          {profile.website ? (
            <Pressable
              onPress={() => {
                // Only http(s): a profile field is a string a stranger chose,
                // and Linking will happily open schemes that are not links.
                if (/^https?:\/\//i.test(profile.website ?? '')) {
                  void Linking.openURL(profile.website as string);
                }
              }}
              hitSlop={6}
            >
              <Text style={styles.website} numberOfLines={1}>
                {profile.website
                  .replace(/^https?:\/\//i, '')
                  .replace(/\/$/, '')}
              </Text>
            </Pressable>
          ) : null}
          {followingCount !== null ? (
            <Text style={styles.following}>
              following{' '}
              <Text style={styles.followingCount}>
                {followingCount.toLocaleString()}
              </Text>
            </Text>
          ) : null}
        </View>
        {status ? (
          <Pressable
            disabled={!status.url}
            onPress={(): void => {
              // The shared reader only keeps an http(s) link.
              if (status.url) void Linking.openURL(status.url);
            }}
          >
            <Text
              style={[styles.status, status.url ? styles.link : null]}
              numberOfLines={2}
            >
              {status.text}
            </Text>
          </Pressable>
        ) : null}

        {profile.about ? (
          <>
            <RichText
              content={profile.about}
              style={styles.about}
              linkStyle={styles.link}
              emoji={profile.emoji}
              numberOfLines={longBio && !bioOpen ? BIO_FOLD_LINES : undefined}
            />
            {longBio ? (
              <Pressable
                onPress={(): void => setBioOpen(!bioOpen)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ expanded: bioOpen }}
              >
                <Text style={styles.more}>
                  {bioOpen ? 'Show less' : 'Show more'}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        <FollowButton target={profile.pubkey} />
        <View style={styles.quietActions}>
          <ZapLink target={profile.pubkey} />
          <MuteButton target={profile.pubkey} />
          <ReportLink target={profile.pubkey} />
        </View>
      </View>

      <View style={styles.divider} />
    </View>
  );
}

export default function Profile({ route }: { route: ProfileRoute }) {
  return <ProfileView pubkey={route.params.pubkey} />;
}

/**
 * The profile itself, taking a pubkey rather than a route.
 *
 * Separated because your own profile is the same page as anybody else's - the
 * only screen that ever needed a different one was the account tab, and that
 * was a settings page with a name that promised a profile.
 */
export function ProfileView({ pubkey }: { pubkey: PubkeyHex }) {
  const [data, setData] = useState<{
    profile: ProfileData;
    posts: NostrEvent[];
  } | null>(null);
  const [rows, setRows] = useState<TimelinePost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | null>(null);
  const [cacheKey, setCacheKey] = useState<TimelineKey | null>(null);
  const [decorating, setDecorating] = useState(true);
  const active: boolean = useIsFocused();
  // A profile is a timeline, and reads further back like one.
  const older = useOlderPosts({
    filter,
    oldestCreatedAt,
    cacheKey,
    posts: rows,
    setPosts: setRows,
    busy: !data || decorating,
    active,
  });
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // The screen is titled with the person, not with the word "Profile".
  useEffect(() => {
    if (data?.profile.name) {
      navigation.setOptions({ title: data.profile.name });
    }
  }, [data?.profile.name, navigation]);
  const statuses = useUserStatuses(rows);
  const own = useOwnReactions(rows.map((row: TimelinePost): string => row.id));

  useEffect(() => {
    let cancelled = false;
    // Once the relays have answered, a slower decoration of the cached
    // posts must not overwrite them.
    let settled = false;
    setDecorating(true);
    loadProfile(pubkey, {
      // The person and their posts as the cache last saw them, drawn from
      // the cache alone while the relays are asked.
      onCached: (cached): void => {
        if (cancelled) return;
        setData(cached);
        void decorateEvents(getRelays(), cached.posts, {
          profiles: 'cached',
          deletions: 'remembered',
          cacheKey: cached.cacheKey,
        })
          .then((decorated): void => {
            if (cancelled || settled) return;
            setRows(decorated.posts);
          })
          .catch((): void => {});
      },
    })
      .then((result): void => {
        if (cancelled) return;
        settled = true;
        setData(result);
        void decorateEvents(getRelays(), result.posts, {
          cacheKey: result.cacheKey,
        })
          .then((decorated): void => {
            if (cancelled) return;
            setRows(decorated.posts);
            setFilter(result.filter);
            setOldestCreatedAt(result.oldestCreatedAt);
            setCacheKey(result.cacheKey);
          })
          .catch((): void => {})
          .finally((): void => {
            if (!cancelled) setDecorating(false);
          });
      })
      .catch((e: any) => setError(String(e?.message ?? e)));
    return (): void => {
      cancelled = true;
    };
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
      data={rows}
      keyExtractor={(post: TimelinePost) => post.key}
      ListHeaderComponent={<Header profile={data.profile} />}
      ListEmptyComponent={
        <Text style={styles.empty}>No posts found on these relays.</Text>
      }
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      {...olderPostsListProps(older)}
      ListFooterComponent={
        <TimelineFooter state={older} hasPosts={rows.length > 0} />
      }
      // The same card the timelines draw. A profile is a timeline; it had a
      // stripped-down renderer of its own for no reason but having been
      // written second, and it showed - no time, no actions, no pictures.
      renderItem={({ item }: { item: TimelinePost }) => (
        <PostRow
          post={item}
          status={statuses.get(item.pubkey) ?? null}
          own={own}
          onOpenThread={() => navigation.push('Thread', { eventId: item.id })}
          onOpenProfile={() =>
            navigation.push('Profile', { pubkey: item.pubkey })
          }
        />
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
  identity: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 10,
    rowGap: 2,
    marginTop: 2,
  },
  nip05: { color: '#89a8ff', fontSize: 13 },
  npub: { color: '#5b6b88', fontSize: 12 },
  following: { color: '#8ea0c0', fontSize: 13 },
  followingCount: { color: '#e8eeff', fontWeight: '700' },
  more: { color: '#89a8ff', fontSize: 13, fontWeight: '700', marginTop: 4 },
  status: {
    color: '#8fa3c7',
    fontSize: 13,
    fontStyle: 'italic',
    marginTop: 6,
  },
  about: { color: '#b9c6de', fontSize: 14, lineHeight: 20, marginTop: 10 },
  website: { color: '#89a8ff', fontSize: 13, maxWidth: 220 },
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
  zapLink: { color: '#ffd79a', fontSize: 12, fontWeight: '700' },
  quietActions: { flexDirection: 'row', gap: 18, marginTop: 12 },
  divider: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  post: { paddingHorizontal: 16, paddingVertical: 14 },
  postContent: { color: '#b9c6de', fontSize: 14, lineHeight: 20 },
  link: { color: '#89a8ff' },
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

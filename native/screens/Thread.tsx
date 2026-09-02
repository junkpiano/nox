/**
 * One post and its replies.
 *
 * This screen is almost entirely shared code: `fetchEventById`,
 * `fetchRepliesForEvent` and `isEventDeleted` all come from the web app's
 * events-queries.ts, unchanged. What is written here is the arrangement.
 *
 * Deletion is checked rather than assumed. NIP-09 is a request, not an
 * erasure - the event is still on relays that chose to keep it - and a client
 * that ignores the request shows people something they asked to withdraw.
 */

import type { RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
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
  TextInput,
  View,
} from 'react-native';
import {
  fetchRepliesForEvent,
  isEventDeleted,
} from '../../src/common/events-queries';
import { isMachineContent } from '../../src/common/machine-content';
import { fetchReferencedEvent } from '../../src/common/referenced-event';
import { unwrapRepost } from '../../src/common/repost';
import { getSessionPrivateKey } from '../../src/common/session';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import PostBody from '../components/PostBody';
import ReportSheet from '../components/ReportSheet';
import { fetchProfilesForPubkeys } from '../lib/home-timeline';
import {
  likeEvent,
  NotSignedInError,
  replyToEvent,
  repostEvent,
} from '../lib/interact';
import { useSessionVersion } from '../lib/use-session-version';

type ThreadRoute = RouteProp<RootStackParamList, 'Thread'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

interface ThreadData {
  root: NostrEvent | null;
  deleted: boolean;
  replies: NostrEvent[];
}

function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * The name and face on a post.
 *
 * Fetched here rather than passed in, because a thread arrives as events and
 * the profiles are a separate question - the same one the timeline asks, so
 * the same cache answers it.
 */
function Author({ pubkey, at }: { pubkey: PubkeyHex; at: number }) {
  const navigation = useNavigation<Nav>();
  const [meta, setMeta] = useState<{
    name: string;
    picture: string | null;
    nip05: string | null;
  } | null>(null);

  useEffect((): (() => void) => {
    let cancelled = false;
    void fetchProfilesForPubkeys([pubkey])
      .then((profiles): void => {
        if (!cancelled) {
          setMeta(profiles.get(pubkey) ?? null);
        }
      })
      .catch((): void => {});
    return (): void => {
      cancelled = true;
    };
  }, [pubkey]);

  return (
    <Pressable
      onPress={(): void => navigation.push('Profile', { pubkey })}
      style={styles.author}
      hitSlop={4}
    >
      {meta?.picture ? (
        <Image source={{ uri: meta.picture }} style={styles.authorAvatar} />
      ) : (
        <View style={[styles.authorAvatar, styles.authorAvatarBlank]} />
      )}
      <View style={styles.authorText}>
        <Text style={styles.authorName} numberOfLines={1}>
          {meta?.name || `${pubkey.slice(0, 8)}...`}
        </Text>
        {meta?.nip05 ? (
          <Text style={styles.authorNip05} numberOfLines={1}>
            {meta.nip05}
          </Text>
        ) : null}
      </View>
      <Text style={styles.meta}>{timeAgo(at)}</Text>
    </Pressable>
  );
}

export default function Thread({ route }: { route: ThreadRoute }) {
  const { eventId } = route.params;
  const [data, setData] = useState<ThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const [liking, setLiking] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [reposting, setReposting] = useState(false);
  const [draft, setDraft] = useState('');
  const [reporting, setReporting] = useState(false);
  // The action row below is drawn from the session key, read at render.
  useSessionVersion();
  /**
   * The composer is behind the reply button rather than always up.
   *
   * A box asking you to write something, on every thread you open, is a
   * question nobody asked - and it pushed the replies themselves below the
   * fold on a phone. It opens straight away when the thread was reached by
   * tapping reply on a card, because there the question was asked.
   */
  const [replying, setReplying] = useState<boolean>(
    route.params.reply ?? false,
  );

  /**
   * The initial state is not enough on its own.
   *
   * `navigate` reuses a Thread already on the stack and only swaps its params,
   * so a screen opened once by the reply button kept its composer open for
   * every thread opened afterwards - a box appearing on a post nobody had
   * asked to answer.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventId is the trigger - a different thread arriving in the same screen resets the box
  useEffect((): void => {
    setReplying(route.params.reply ?? false);
  }, [route.params.reply, route.params.eventId]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  const navigation = useNavigation<Nav>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sent` is the trigger, not a read
  useEffect(() => {
    let cancelled = false;
    const relays = getRelays();

    (async (): Promise<void> => {
      try {
        const fetched = await fetchReferencedEvent(eventId, relays);
        if (cancelled) return;
        // A repost opened directly shows the note it reposted, never its
        // own content - which is that note as JSON. Without an embedded
        // copy the target is fetched, cache first.
        let root: NostrEvent | null = fetched;
        if (fetched) {
          const unwrapped = unwrapRepost(fetched);
          if (unwrapped.repostedBy) {
            root =
              unwrapped.event ??
              (unwrapped.targetId
                ? await fetchReferencedEvent(unwrapped.targetId, relays)
                : null);
            if (cancelled) return;
          }
        }
        if (!root) {
          setData({ root: null, deleted: false, replies: [] });
          return;
        }

        // Replies and the deletion check run together: neither depends on the
        // other, and the thread is not readable until both have answered.
        const [deleted, replies] = await Promise.all([
          isEventDeleted(root.id, root.pubkey as PubkeyHex, relays),
          fetchRepliesForEvent(root.id, relays),
        ]);
        if (cancelled) return;

        setData({
          root,
          deleted,
          // Reached by a link or a notification, this screen bypasses the
          // timeline's filter, so it applies the same one.
          replies: replies
            .filter(
              (reply: NostrEvent): boolean => !isMachineContent(reply.content),
            )
            .sort(
              (a: NostrEvent, b: NostrEvent): number =>
                a.created_at - b.created_at,
            ),
        });
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message ?? e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, sent]);

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

  if (!data.root) {
    return (
      <View style={styles.centre}>
        <Text style={styles.empty}>
          None of your relays has this event. It may exist elsewhere.
        </Text>
      </View>
    );
  }

  const root: NostrEvent = data.root;

  /** One place to report what a write actually did, rather than three. */
  const attempt = async (
    what: string,
    run: () => Promise<{ accepted: string[] }>,
    onDone: () => void,
  ): Promise<void> => {
    try {
      const result = await run();
      if (result.accepted.length === 0) {
        Alert.alert('Not sent', `No relay accepted the ${what}.`);
        return;
      }
      onDone();
    } catch (e: any) {
      if (e instanceof NotSignedInError) {
        Alert.alert('Not signed in', 'Add a key on the You tab to take part.');
      } else {
        Alert.alert(`Could not ${what}`, String(e?.message ?? e));
      }
    }
  };

  const like = async (): Promise<void> => {
    setLiking(true);
    // Marked only once a relay has it: a like nobody stored is not a like, and
    // showing it as one would be a small lie that persists.
    await attempt(
      'reaction',
      () => likeEvent(root),
      () => setLiked(true),
    );
    setLiking(false);
  };

  const repost = async (): Promise<void> => {
    setReposting(true);
    await attempt(
      'repost',
      () => repostEvent(root),
      () => setReposted(true),
    );
    setReposting(false);
  };

  const reply = async (): Promise<void> => {
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    await attempt(
      'reply',
      () => replyToEvent(root, content),
      (): void => {
        setDraft('');
        // Bumping this re-runs the thread load, so the reply appears where it
        // belongs rather than being pasted in optimistically at the end.
        setSent((n: number): number => n + 1);
      },
    );
    setSending(false);
  };

  return (
    <FlatList
      style={styles.screen}
      data={data.replies}
      keyExtractor={(event: NostrEvent) => event.id}
      ListHeaderComponent={
        <View>
          <Pressable
            onPress={() =>
              navigation.navigate('Profile', {
                pubkey: root.pubkey as PubkeyHex,
              })
            }
            style={styles.rootPost}
          >
            {/* Who wrote it. The screen showed a time and a body and nothing
                else, so an event page was a paragraph from nobody. */}
            <Author pubkey={root.pubkey as PubkeyHex} at={root.created_at} />
            {data.deleted ? (
              <Text style={styles.deleted}>
                The author asked for this to be deleted.
              </Text>
            ) : isMachineContent(root.content) ? (
              <Text style={styles.deleted}>
                This note is data written for software, not text.
              </Text>
            ) : (
              <PostBody
                content={root.content}
                textStyle={styles.rootContent}
                linkStyle={styles.link}
              />
            )}
          </Pressable>
          {getSessionPrivateKey() && !data.deleted ? (
            <View style={styles.actions}>
              <View style={styles.actionRow}>
                <Pressable
                  onPress={(): void => setReplying((open) => !open)}
                  style={styles.action}
                >
                  {/* The same button whether the box is open or shut. It
                      relabelled itself "Cancel", which reads as cancelling
                      the post rather than closing a composer. */}
                  <Text
                    accessibilityLabel="Reply"
                    style={replying ? styles.actionDone : styles.actionText}
                  >
                    ↩
                  </Text>
                </Pressable>
                <Pressable
                  onPress={repost}
                  disabled={reposting || reposted}
                  style={[
                    styles.action,
                    (reposting || reposted) && styles.actionOff,
                  ]}
                >
                  <Text
                    accessibilityLabel="Repost"
                    style={reposted ? styles.actionDone : styles.actionText}
                  >
                    {reposting ? '···' : '⇄'}
                  </Text>
                </Pressable>
                {/* A post can be reported by anyone who can sign, including
                    somebody who does not want to mute the author - so it sits
                    with the other post actions rather than on the profile. */}
                <Pressable
                  onPress={like}
                  disabled={liking || liked}
                  style={[styles.action, (liking || liked) && styles.actionOff]}
                >
                  <Text
                    accessibilityLabel="Like"
                    style={liked ? styles.actionDone : styles.actionText}
                  >
                    {liking ? '···' : liked ? '♥' : '♡'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={(): void => setReporting(true)}
                  style={styles.action}
                >
                  <Text accessibilityLabel="Report" style={styles.reportText}>
                    ⚑
                  </Text>
                </Pressable>
              </View>

              {replying ? (
                <>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Write a reply"
                    placeholderTextColor="#5b6b88"
                    multiline
                    autoFocus
                    style={styles.replyInput}
                  />
                  <Pressable
                    onPress={reply}
                    disabled={sending || draft.trim().length === 0}
                    style={[
                      styles.replyButton,
                      (sending || draft.trim().length === 0) &&
                        styles.actionOff,
                    ]}
                  >
                    <Text style={styles.replyButtonText}>
                      {sending ? 'Sending...' : 'Send reply'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.replyHeading}>
            {data.replies.length === 0
              ? 'No replies'
              : `${data.replies.length} ${data.replies.length === 1 ? 'reply' : 'replies'}`}
          </Text>
        </View>
      }
      ListFooterComponent={
        <ReportSheet
          visible={reporting}
          target={root.pubkey as PubkeyHex}
          eventId={root.id}
          onClose={(): void => setReporting(false)}
        />
      }
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      renderItem={({ item }: { item: NostrEvent }) => (
        <Pressable
          onPress={() => navigation.push('Thread', { eventId: item.id })}
          style={({ pressed }) => [
            styles.reply,
            pressed && styles.replyPressed,
          ]}
        >
          <Author pubkey={item.pubkey as PubkeyHex} at={item.created_at} />
          <PostBody
            content={item.content}
            textStyle={styles.replyContent}
            linkStyle={styles.link}
            numberOfLines={12}
          />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  rootPost: { padding: 16 },
  rootContent: { color: '#e8eeff', fontSize: 16, lineHeight: 23, marginTop: 6 },
  deleted: {
    color: '#8ea0c0',
    fontSize: 14,
    fontStyle: 'italic',
    marginTop: 6,
  },
  author: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  authorAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#25406e',
  },
  authorAvatarBlank: { opacity: 0.5 },
  authorText: { flex: 1 },
  authorName: { color: '#e8eeff', fontWeight: '700', fontSize: 14 },
  authorNip05: { color: '#5b6b88', fontSize: 11, marginTop: 1 },
  meta: { color: '#5b6b88', fontSize: 11 },
  likeButton: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actions: { paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  actionRow: { flexDirection: 'row', gap: 8 },
  action: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionOff: { opacity: 0.5 },
  link: { color: '#89a8ff' },
  reportText: { color: '#8ea0c0', fontSize: 18 },
  actionText: { color: '#89a8ff', fontSize: 20 },
  actionDone: { color: '#73f0c1', fontSize: 20 },
  replyInput: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#101a2e',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  replyButton: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  replyButtonText: { color: '#0b1220', fontWeight: '700', fontSize: 14 },
  replyHeading: {
    color: '#8ea0c0',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#101a2e',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(148,163,184,0.14)',
  },
  reply: { paddingHorizontal: 16, paddingVertical: 14 },
  replyPressed: { backgroundColor: 'rgba(137,168,255,0.08)' },
  replyContent: {
    color: '#b9c6de',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  sep: { height: 1, backgroundColor: 'rgba(148,163,184,0.14)' },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
    padding: 24,
  },
  error: { color: '#ff9a9a', fontSize: 13 },
  empty: { color: '#5b6b88', fontSize: 13, textAlign: 'center' },
});

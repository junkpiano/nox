/**
 * A quoted note, drawn as a card under the post that quoted it.
 *
 * The reference in the text is thirty characters of bech32; the thing it
 * refers to is somebody's post, and it is the post the reader wants.
 *
 * Fetched through the shared referenced-event path, not straight from the
 * relays: cache first, one request per id however many cards want it, and
 * the relays an `nevent` named asked before the configured list - a note that
 * lives only where its author said it does is the case hints exist for.
 *
 * The quoted note gets the same NIP-36 treatment as a post in the timeline.
 * A warning is the author asking not to be shown unasked, and being quoted by
 * somebody else does not withdraw that. Revealing is per card and forgotten.
 *
 * Quotes inside the quoted note are not rendered - a card in a card in a card
 * ends with one post filling the screen. One level, then a tap to go deeper.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  type ContentWarning,
  contentWarningSummary,
  getContentWarning,
} from '../../src/common/content-warning';
import { isMachineContent } from '../../src/common/machine-content';
import { fetchReferencedEvent } from '../../src/common/referenced-event';
import { unwrapRepost } from '../../src/common/repost';
import { getRelays } from '../../src/features/relays/relays';
import type { NostrEvent, PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { customEmojiOf } from '../lib/avatar';
import {
  fetchProfilesForPubkeys,
  type ProfileMeta,
} from '../lib/home-timeline';
import RichText from './RichText';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export interface QuoteCardProps {
  eventId: string;
  /** Relay hints the reference carried, if it was an `nevent`. */
  relays?: string[];
}

export default function QuoteCard({ eventId, relays }: QuoteCardProps) {
  const navigation = useNavigation<Nav>();
  const [quoted, setQuoted] = useState<NostrEvent | null>(null);
  const [author, setAuthor] = useState<ProfileMeta | null>(null);
  const [missing, setMissing] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // The hints are part of the reference, not a reason to refetch on their
  // own: a new array of the same relays would otherwise ask again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined hints are the dependency, not the array
  useEffect((): (() => void) => {
    let cancelled = false;
    setRevealed(false);
    void fetchReferencedEvent(eventId, getRelays(), {
      ...(relays && relays.length > 0 ? { hintRelays: relays } : {}),
    })
      .then(async (fetched): Promise<void> => {
        if (cancelled) return;
        // A quoted repost shows the note it reposted, never its own
        // content, which is that note as JSON.
        let event: NostrEvent | null = fetched;
        if (fetched) {
          const unwrapped = unwrapRepost(fetched);
          if (unwrapped.repostedBy) {
            event =
              unwrapped.event ??
              (unwrapped.targetId
                ? await fetchReferencedEvent(unwrapped.targetId, getRelays())
                : null);
            if (cancelled) return;
          }
        }
        // Data, not words. The timeline hides these; a card reached through a
        // quote must not become the way they get drawn after all.
        if (!event || isMachineContent(event.content)) {
          setMissing(true);
          return;
        }
        setQuoted(event);
        void fetchProfilesForPubkeys([event.pubkey as PubkeyHex])
          .then((profiles): void => {
            if (!cancelled) {
              setAuthor(profiles.get(event.pubkey) ?? null);
            }
          })
          .catch((): void => {});
      })
      .catch((): void => {
        if (!cancelled) setMissing(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [eventId, relays?.join(',')]);

  if (missing) {
    // Still worth a card: the quote exists in the text, and rendering nothing
    // makes the post read as if it said less than it did.
    return (
      <View style={styles.card}>
        <Text style={styles.missing}>
          Quoted note not found on these relays.
        </Text>
      </View>
    );
  }

  if (!quoted) {
    return (
      <View style={styles.card}>
        <Text style={styles.missing}>Loading quoted note…</Text>
      </View>
    );
  }

  const warning: ContentWarning = getContentWarning(quoted);
  const covered: boolean = warning.hasWarning && !revealed;

  const head = (
    <View style={styles.head}>
      {author?.picture ? (
        <Image source={{ uri: author.picture }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarBlank]} />
      )}
      <Text style={styles.name} numberOfLines={1}>
        {author?.name || `${quoted.pubkey.slice(0, 8)}...`}
      </Text>
    </View>
  );

  if (covered) {
    // Not a Pressable inside a Pressable: the inner one does not reliably win
    // the touch, and a cover that opened the thread instead of revealing would
    // show the post by a different route. While covered, the card only
    // reveals; once revealed, it navigates.
    return (
      <View style={styles.card}>
        {head}
        <Pressable
          onPress={(): void => setRevealed(true)}
          style={styles.warning}
        >
          <Text style={styles.warningText}>
            ⚠️ {contentWarningSummary(warning)}
          </Text>
          <Text style={styles.warningHint}>Tap to show</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={(): void => navigation.push('Thread', { eventId })}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      {head}
      <RichText
        content={quoted.content}
        style={styles.content}
        linkStyle={styles.link}
        numberOfLines={6}
        emoji={customEmojiOf(quoted.tags)}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#101a2e',
    gap: 6,
  },
  pressed: { backgroundColor: '#16233f' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#25406e',
  },
  avatarBlank: { opacity: 0.5 },
  name: { color: '#e8eeff', fontWeight: '700', fontSize: 13, flexShrink: 1 },
  content: { color: '#b9c6de', fontSize: 13, lineHeight: 19 },
  link: { color: '#89a8ff' },
  missing: { color: '#5b6b88', fontSize: 12 },
  warning: {
    borderWidth: 1,
    borderColor: '#4a3a1a',
    backgroundColor: '#221a0d',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warningText: { color: '#ffd79a', fontSize: 13, lineHeight: 18 },
  warningHint: { color: '#8a7550', fontSize: 11, marginTop: 4 },
});

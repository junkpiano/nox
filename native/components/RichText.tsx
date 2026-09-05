/**
 * A post's text, with the parts that are not text made tappable.
 *
 * The finding is shared with the web app (`common/content-segments.ts`); what
 * is here is the rendering. Nested `<Text>` is the only way to get inline
 * tappable runs on this platform - a `View` would break the line box and put
 * every link on its own line.
 *
 * Mentions show a name when one is known and a short identifier when it is
 * not. The name is fetched in the background, per pubkey, and cached for the
 * process: a timeline full of the same few people would otherwise ask the
 * relays once per card.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import {
  Image,
  Linking,
  type NativeSyntheticEvent,
  type StyleProp,
  StyleSheet,
  Text,
  type TextLayoutEventData,
  type TextStyle,
} from 'react-native';

import type {
  ContentSegment,
  EmojiMap,
} from '../../src/common/content-segments';
import {
  parseContentSegments,
  shortIdentifier,
} from '../../src/common/content-segments';
import type { PubkeyHex } from '../../types/nostr';
import type { RootStackParamList } from '../App';
import { fetchProfilesForPubkeys } from '../lib/home-timeline';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Process-wide, because the same people are mentioned over and over. */
const names: Map<PubkeyHex, string> = new Map();
const pending: Set<PubkeyHex> = new Set();
const listeners: Set<() => void> = new Set();

function announce(): void {
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function resolveNames(pubkeys: PubkeyHex[]): void {
  const wanted: PubkeyHex[] = pubkeys.filter(
    (pubkey: PubkeyHex): boolean => !names.has(pubkey) && !pending.has(pubkey),
  );
  if (wanted.length === 0) {
    return;
  }
  for (const pubkey of wanted) {
    pending.add(pubkey);
  }

  void fetchProfilesForPubkeys(wanted)
    .then((profiles): void => {
      let found = false;
      for (const pubkey of wanted) {
        const name: string | undefined = profiles.get(pubkey)?.name;
        if (name) {
          names.set(pubkey, name);
          found = true;
        }
      }
      if (found) {
        announce();
      }
    })
    .catch((): void => {
      // A name is a nicety. The short identifier is already on screen and the
      // link already works.
    })
    .finally((): void => {
      for (const pubkey of wanted) {
        pending.delete(pubkey);
      }
    });
}

export interface RichTextProps {
  content: string;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** The rendered lines, for a caller deciding whether to fold. */
  onTextLayout?: (event: NativeSyntheticEvent<TextLayoutEventData>) => void;
  /** NIP-30: the event's own emoji, drawn inline where their shortcodes are. */
  emoji?: EmojiMap;
}

/** An inline picture the height of the line, give or take. */
function emojiSize(style: StyleProp<TextStyle>): number {
  const fontSize: number = StyleSheet.flatten(style)?.fontSize ?? 14;
  return Math.round(fontSize * 1.3);
}

export default function RichText({
  content,
  style,
  linkStyle,
  numberOfLines,
  onTextLayout,
  emoji,
}: RichTextProps) {
  const navigation = useNavigation<Nav>();
  const segments: ContentSegment[] = parseContentSegments(content, emoji);
  const size: number = emojiSize(style);
  const [, bump] = useState(0);

  const mentioned: PubkeyHex[] = segments.flatMap(
    (segment: ContentSegment): PubkeyHex[] =>
      segment.kind === 'mention' && segment.pubkey ? [segment.pubkey] : [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pubkeys are the dependency, not the array
  useEffect((): (() => void) => {
    const listener = (): void => bump((n: number): number => n + 1);
    listeners.add(listener);
    resolveNames(mentioned);
    return (): void => {
      listeners.delete(listener);
    };
    // The pubkeys, not the array: a new array every render would refetch
    // forever.
  }, [mentioned.join(',')]);

  return (
    <Text
      style={style}
      numberOfLines={numberOfLines}
      onTextLayout={onTextLayout}
    >
      {segments.map((segment: ContentSegment, index: number) => {
        const key = `${index}-${segment.kind}`;

        if (segment.kind === 'url') {
          return (
            <Text
              key={key}
              style={linkStyle}
              onPress={(): void => {
                // http(s) only, which the parser already guarantees: a scheme
                // somebody else chose is not something to hand to the system.
                void Linking.openURL(segment.url);
              }}
            >
              {segment.text}
            </Text>
          );
        }

        if (segment.kind === 'mention') {
          const pubkey: PubkeyHex | null = segment.pubkey;
          const label: string = pubkey
            ? `@${names.get(pubkey) ?? shortIdentifier(segment.text)}`
            : segment.text;
          if (!pubkey) {
            // Undecodable: shown as written rather than as a link to nowhere.
            return <Text key={key}>{label}</Text>;
          }
          return (
            <Text
              key={key}
              style={linkStyle}
              onPress={(): void => navigation.navigate('Profile', { pubkey })}
            >
              {label}
            </Text>
          );
        }

        if (segment.kind === 'hashtag') {
          return (
            <Text
              key={key}
              style={linkStyle}
              onPress={(): void =>
                navigation.navigate('Hashtag', { tag: segment.tag })
              }
            >
              {segment.text}
            </Text>
          );
        }

        if (segment.kind === 'emoji') {
          // An Image inside a Text is the one inline element this platform
          // allows, which is exactly what an emoji is.
          return (
            <Image
              key={key}
              source={{ uri: segment.url }}
              style={{ width: size, height: size }}
              accessibilityLabel={segment.text}
            />
          );
        }

        if (segment.kind === 'event') {
          const eventId: string | null = segment.eventId;
          if (!eventId) {
            return <Text key={key}>{segment.text}</Text>;
          }
          return (
            <Text
              key={key}
              style={linkStyle}
              onPress={(): void => navigation.navigate('Thread', { eventId })}
            >
              {`↗ ${shortIdentifier(segment.text)}`}
            </Text>
          );
        }

        return <Text key={key}>{segment.text}</Text>;
      })}
    </Text>
  );
}
